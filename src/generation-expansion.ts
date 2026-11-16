import { Gate } from './types.js'
import { getVars } from './utils.js'

export type ExpansionParent = { state: Uint8Array, mask: number, reads: number }
export type ExpansionTask = { parents: ArrayBuffer, gateStart: number, gateEnd: number }
export type ExpansionResult = { candidates: ArrayBuffer, attempts: number, count: number, expansionMs: number }

/** Own contiguous buffers can be transferred, rather than cloning arrays of objects. */
export function packParents(entries: ExpansionParent[], stateBytes: number) {
	const buffer = new ArrayBuffer(entries.length * (stateBytes + 8)), view = new DataView(buffer)
	for (let i = 0; i < entries.length; i++) {
		const entry = entries[i], offset = i * (stateBytes + 8)
		if (entry.state.length !== stateBytes || !Number.isSafeInteger(entry.mask) || entry.mask < 0 || entry.mask > 255 || !Number.isSafeInteger(entry.reads) || entry.reads < 0 || entry.reads > 0xffffffff) throw new Error('Invalid expansion parent')
		new Uint8Array(buffer, offset, stateBytes).set(entry.state)
		view.setUint32(offset + stateBytes, entry.mask, true)
		view.setUint32(offset + stateBytes + 4, entry.reads, true)
	}
	return buffer
}

/** Gate transitions are shared by every expansion performed by this kernel. */
export class ExpansionKernel {
	readonly stateBytes: number
	private gates: { transitions: Uint8Array, mask: number, reads: number }[]
	constructor(wires: number, catalog: Gate[]) {
		if (!Number.isInteger(wires) || wires < 1 || wires > 8) throw new Error('Expansion supports 1–8 wires')
		this.stateBytes = 2 ** wires
		this.gates = catalog.map(gate => {
			const variables = getVars(gate)
			return {
				mask: variables.reduce((mask, wire) => mask | 1 << wire, 0), reads: variables.length,
				transitions: Uint8Array.from({ length: this.stateBytes }, (_, word) => {
					const a = word >>> gate.a & 1, b = word >>> gate.b & 1
					return word ^ ((gate.gate_i >>> (3 - (a * 2 + b)) & 1) << gate.target)
				}),
			}
		})
	}
	expand({ parents, gateStart, gateEnd }: ExpansionTask): ExpansionResult {
		const started = performance.now(), stride = this.stateBytes + 8
		if (parents.byteLength % stride || !Number.isInteger(gateStart) || !Number.isInteger(gateEnd) || gateStart < 0 || gateEnd > this.gates.length || gateEnd < gateStart) throw new Error('Invalid expansion task')
		const view = new DataView(parents)
		const candidates = new Map<string, { state: Buffer, parent: number, gate: number, mask: number, reads: number }>()
		const scratch = Buffer.allocUnsafe(this.stateBytes)
		let attempts = 0
		for (let parent = 0; parent < parents.byteLength / stride; parent++) {
			const offset = parent * stride, state = new Uint8Array(parents, offset, this.stateBytes)
			const parentMask = view.getUint32(offset + this.stateBytes, true), parentReads = view.getUint32(offset + this.stateBytes + 4, true)
			for (let index = gateStart; index < gateEnd; index++) {
				attempts++
				const gate = this.gates[index], mask = parentMask | gate.mask, reads = parentReads + gate.reads
				if (reads > 0xffffffff) throw new Error('Expansion read cost exceeds supported range')
				for (let i = 0; i < state.length; i++) scratch[i] = gate.transitions[state[i]]
				const key = `${scratch.toString('hex')}:${mask}`, prior = candidates.get(key)
				if (!prior || reads < prior.reads) candidates.set(key, { state: Buffer.from(scratch), parent, gate: index, mask, reads })
			}
		}
		// Gate sequences stay in the writer. Only surviving parent/gate references cross threads.
		const outputStride = this.stateBytes + 16, output = new ArrayBuffer(candidates.size * outputStride), result = new DataView(output)
		let offset = 0
		for (const candidate of candidates.values()) {
			new Uint8Array(output, offset, this.stateBytes).set(candidate.state)
			result.setUint32(offset + this.stateBytes, candidate.parent, true)
			result.setUint32(offset + this.stateBytes + 4, candidate.gate, true)
			result.setUint32(offset + this.stateBytes + 8, candidate.mask, true)
			result.setUint32(offset + this.stateBytes + 12, candidate.reads, true)
			offset += outputStride
		}
		return { candidates: output, count: candidates.size, attempts, expansionMs: performance.now() - started }
	}
}

/** Pack a truth-table state directly, without expanding it into boolean objects. */
export function stateIdentifier(state: Uint8Array, wires: number) {
	const packed = Buffer.alloc(Math.ceil(state.length * wires / 8))
	for (let i = 0; i < state.length; i++) {
		const bit = i * wires, shift = bit & 7
		packed[bit >>> 3] |= state[i] << shift
		if (shift + wires > 8) packed[(bit >>> 3) + 1] |= state[i] >>> (8 - shift)
	}
	return packed.toString('hex')
}
