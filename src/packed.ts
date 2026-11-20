import { Gate } from './types.js'

export const sameGate = (a: Gate, b: Gate) => a.a === b.a && a.b === b.b && a.target === b.target && a.gate_i === b.gate_i
export function packedControl(f: number, a: number, b: number) {
	return ((f & 8) ? ~a & ~b : 0) | ((f & 4) ? ~a & b : 0) | ((f & 2) ? a & ~b : 0) | ((f & 1) ? a & b : 0)
}

function applyPackedGate(state: Uint32Array, gate: Gate, offset: number, mask: number) {
	const f = gate.gate_i
	if (!Number.isInteger(f) || f < 0 || f > 15) throw new Error(`invalid control function: ${f}`)
	const a = state[offset + gate.a], b = state[offset + gate.b]
	const control = packedControl(f, a, b)
	state[offset + gate.target] = (state[offset + gate.target] ^ control) & mask
}

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
	private readonly checkpointSpacing: number
	private scratch?: Uint32Array
	constructor(gates: Gate[], inputs: boolean[][] | PackedInputs, prefixBytes: number, stride: number) {
		const packed = inputs instanceof PackedInputs ? inputs : new PackedInputs(inputs)
		this.inputs = packed.inputs
		this.wires = packed.wires
		this.batches = packed.batches
		this.initial = packed.initial
		this.masks = packed.masks
		const capacity = this.initial.byteLength ? Math.floor(prefixBytes / this.initial.byteLength) : 0
		this.gates = capacity ? gates.map(gate => ({ ...gate })) : gates
		const spacing = Math.max(stride, Math.ceil(gates.length / Math.max(1, capacity)))
		this.checkpointSpacing = spacing
		const state = this.initial.slice()
		gates.forEach((gate, i) => {
			this.apply(state, gate)
			if (capacity && (i + 1) % spacing === 0 && this.checkpoints.size < capacity) this.checkpoints.set(i + 1, state.slice())
		})
		this.reference = state
	}
	private apply(state: Uint32Array, gate: Gate) {
		for (let batch = 0; batch < this.batches; batch++) applyPackedGate(state, gate, batch * this.wires, this.masks[batch])
	}
	private prefix(candidate: Gate[], knownPrefix?: number) {
		if (!this.checkpoints.size) return { start: 0, prefix: this.initial }
		let common = knownPrefix ?? 0
		if (knownPrefix === undefined) {
			while (common < candidate.length && common < this.gates.length && sameGate(candidate[common], this.gates[common])) common++
		}
		const spacing = this.checkpointSpacing
		if (Number.isSafeInteger(spacing)) {
			const start = Math.min(Math.floor(common / spacing), this.checkpoints.size) * spacing
			if (start === 0) return { start, prefix: this.initial }
			const prefix = this.checkpoints.get(start)
			if (prefix) return { start, prefix }
		}
		// Non-integer strides can produce checkpoints on a different grid.
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
	/** A known prefix must have the same effect as the reference on every input. */
	equivalent(candidate: Gate[], knownPrefix?: number) {
		if (!this.batches) return true
		const { start, prefix } = this.prefix(candidate, knownPrefix)
		const state = this.scratch ??= new Uint32Array(this.wires)
		for (let batch = 0; batch < this.batches; batch++) {
			const offset = batch * this.wires
			for (let wire = 0; wire < this.wires; wire++) state[wire] = prefix[offset + wire]
			for (let i = start; i < candidate.length; i++) applyPackedGate(state, candidate[i], 0, this.masks[batch])
			for (let wire = 0; wire < this.wires; wire++) if (state[wire] !== this.reference[offset + wire]) return false
		}
		return true
	}
	/** Compare one wire's reference output with its input in every batch. */
	leavesWireUnchanged(wire: number) {
		for (let batch = 0; batch < this.batches; batch++) {
			const offset = batch * this.wires + wire
			if (this.initial[offset] !== this.reference[offset]) return false
		}
		return true
	}
	unpack(state = this.reference) {
		return this.inputs.map((_, i) => Array.from({ length: this.wires }, (_, wire) => ((state[Math.floor(i / 32) * this.wires + wire] >>> (i % 32)) & 1) !== 0))
	}
}

/** A single packed sample batch with caller-supplied unchanged prefixes. */
export class FirstBatchEvaluator {
	private readonly spacing: number
	private readonly checkpointCount: number
	private readonly checkpoints: Uint32Array
	private readonly reference: Uint32Array
	private readonly scratch: Uint32Array

	constructor(gates: Gate[], private readonly packed: PackedInputs, prefixBytes: number) {
		if (packed.batches !== 1) throw new Error('First batch evaluation requires one packed batch')
		const { wires, initial, masks } = packed
		const mask = masks[0]
		const capacity = initial.byteLength ? Math.max(0, Math.floor(prefixBytes / initial.byteLength)) : 0
		this.spacing = Math.max(1, Math.ceil(gates.length / Math.max(1, capacity)))
		this.checkpointCount = Math.min(capacity, Math.floor(gates.length / this.spacing))
		this.checkpoints = new Uint32Array(this.checkpointCount * wires)
		const state = initial.slice()
		let checkpoint = 0, nextCheckpoint = this.spacing
		for (let i = 0; i < gates.length; i++) {
			applyPackedGate(state, gates[i], 0, mask)
			if (i + 1 === nextCheckpoint && checkpoint < this.checkpointCount) {
				this.checkpoints.set(state, checkpoint * wires)
				checkpoint++
				nextCheckpoint += this.spacing
			}
		}
		this.reference = state
		this.scratch = new Uint32Array(wires)
	}

	/** The supplied prefix must have the same effect as the reference. */
	equivalent(candidate: Gate[], knownPrefix: number) {
		const { wires, initial, masks } = this.packed
		const mask = masks[0]
		const checkpoint = Math.min(Math.floor(knownPrefix / this.spacing), this.checkpointCount)
		const start = checkpoint * this.spacing
		const prefix = checkpoint ? this.checkpoints : initial
		const offset = checkpoint ? (checkpoint - 1) * wires : 0
		const state = this.scratch
		for (let wire = 0; wire < wires; wire++) state[wire] = prefix[offset + wire]
		for (let i = start; i < candidate.length; i++) applyPackedGate(state, candidate[i], 0, mask)
		for (let wire = 0; wire < wires; wire++) if (state[wire] !== this.reference[wire]) return false
		return true
	}
}
