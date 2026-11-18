import { Gate } from './types.js'

const sameGate = (a: Gate, b: Gate) => a.a === b.a && a.b === b.b && a.target === b.target && a.gate_i === b.gate_i

/** Immutable input batches can be reused across reference circuits. */
export class PackedInputs {
	readonly wires: number
	readonly batches: number
	readonly initial: Uint32Array
	readonly masks: Uint32Array
	constructor(readonly inputs: boolean[][]) {
		this.wires = inputs[0]?.length ?? 0
		this.batches = Math.ceil(inputs.length / 32)
		this.initial = new Uint32Array(this.batches * this.wires)
		this.masks = Uint32Array.from({ length: this.batches }, (_, batch) => {
			const count = Math.min(32, inputs.length - batch * 32)
			return count === 32 ? 0xffffffff : 2 ** count - 1
		})
		inputs.forEach((input, i) => input.forEach((value, wire) => {
			if (value) this.initial[Math.floor(i / 32) * this.wires + wire] |= 1 << (i % 32)
		}))
	}
}

/** Packed inputs remain packed throughout candidate comparison. */
export class IncrementalEvaluator {
	readonly reference: Uint32Array
	readonly gates: Gate[]
	readonly checkpoints = new Map<number, Uint32Array>()
	readonly inputs: boolean[][]
	readonly wires: number
	readonly batches: number
	private initial: Uint32Array
	private masks: Uint32Array
	constructor(gates: Gate[], inputs: boolean[][] | PackedInputs, prefixBytes: number, stride: number) {
		this.gates = gates.map(gate => ({ ...gate }))
		const packed = inputs instanceof PackedInputs ? inputs : new PackedInputs(inputs)
		this.inputs = packed.inputs
		this.wires = packed.wires
		this.batches = packed.batches
		this.initial = packed.initial
		this.masks = packed.masks
		const capacity = this.initial.byteLength ? Math.floor(prefixBytes / this.initial.byteLength) : 0
		const spacing = Math.max(stride, Math.ceil(gates.length / Math.max(1, capacity)))
		const state = this.initial.slice()
		gates.forEach((gate, i) => {
			this.apply(state, gate)
			if (capacity && (i + 1) % spacing === 0 && this.checkpoints.size < capacity) this.checkpoints.set(i + 1, state.slice())
		})
		this.reference = state
	}
	private applyAt(state: Uint32Array, gate: Gate, offset: number, mask: number) {
		const f = gate.gate_i
		if (!Number.isInteger(f) || f < 0 || f > 15) throw new Error(`invalid control function: ${f}`)
		const a = state[offset + gate.a], b = state[offset + gate.b]
		const control = ((f & 8) ? ~a & ~b : 0) | ((f & 4) ? ~a & b : 0) | ((f & 2) ? a & ~b : 0) | ((f & 1) ? a & b : 0)
		state[offset + gate.target] = (state[offset + gate.target] ^ control) & mask
	}
	private apply(state: Uint32Array, gate: Gate) {
		for (let batch = 0; batch < this.batches; batch++) this.applyAt(state, gate, batch * this.wires, this.masks[batch])
	}
	private prefix(candidate: Gate[]) {
		let common = 0
		while (common < candidate.length && common < this.gates.length && sameGate(candidate[common], this.gates[common])) common++
		let start = 0, prefix = this.initial
		for (const [line, state] of this.checkpoints) {
			if (line > common) break
			start = line
			prefix = state
		}
		return { start, prefix }
	}
	evaluate(candidate: Gate[]) {
		const { start, prefix } = this.prefix(candidate)
		const state = prefix.slice()
		for (let i = start; i < candidate.length; i++) this.apply(state, candidate[i])
		return state
	}
	equivalent(candidate: Gate[]) {
		const { start, prefix } = this.prefix(candidate)
		for (let batch = 0; batch < this.batches; batch++) {
			const offset = batch * this.wires
			const state = prefix.slice(offset, offset + this.wires)
			for (let i = start; i < candidate.length; i++) this.applyAt(state, candidate[i], 0, this.masks[batch])
			for (let wire = 0; wire < this.wires; wire++) if (state[wire] !== this.reference[offset + wire]) return false
		}
		return true
	}
	unpack(state = this.reference) {
		return this.inputs.map((_, i) => Array.from({ length: this.wires }, (_, wire) => ((state[Math.floor(i / 32) * this.wires + wire] >>> (i % 32)) & 1) !== 0))
	}
}
