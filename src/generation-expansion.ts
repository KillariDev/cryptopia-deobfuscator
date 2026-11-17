import { Gate } from './types.js'
import { getVars } from './utils.js'
import { packState } from './generation-storage.js'

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
		const maximum = parents.byteLength / stride * (gateEnd - gateStart)
		if (!Number.isSafeInteger(maximum) || maximum > 0x1fffffff) throw new Error('Expansion task exceeds supported capacity')
		let capacity = 1
		while (capacity < maximum * 2) capacity *= 2
		const slots = new Int32Array(capacity), outputStride = this.stateBytes + 16
		const output = new ArrayBuffer(maximum * outputStride), bytes = new Uint8Array(output), result = new DataView(output)
		const scratch = new Uint8Array(this.stateBytes)
		let count = 0
		let attempts = 0
		for (let parent = 0; parent < parents.byteLength / stride; parent++) {
			const offset = parent * stride, state = new Uint8Array(parents, offset, this.stateBytes)
			const parentMask = view.getUint32(offset + this.stateBytes, true), parentReads = view.getUint32(offset + this.stateBytes + 4, true)
			for (let index = gateStart; index < gateEnd; index++) {
				attempts++
				const gate = this.gates[index], mask = parentMask | gate.mask, reads = parentReads + gate.reads
				if (reads > 0xffffffff) throw new Error('Expansion read cost exceeds supported range')
				for (let i = 0; i < state.length; i++) scratch[i] = gate.transitions[state[i]]
				let hash = 2166136261
				for (const value of scratch) hash = Math.imul(hash ^ value, 16777619)
				hash = Math.imul(hash ^ mask, 16777619)
				let slot = hash & (capacity - 1), candidate = -1
				while (slots[slot]) {
					const index = slots[slot] - 1, offset = index * outputStride
					let equal = result.getUint32(offset + this.stateBytes + 8, true) === mask
					for (let i = 0; equal && i < scratch.length; i++) equal = bytes[offset + i] === scratch[i]
					if (equal) { candidate = index; break }
					slot = (slot + 1) & (capacity - 1)
				}
				if (candidate === -1) {
					candidate = count++; slots[slot] = candidate + 1
					bytes.set(scratch, candidate * outputStride)
				} else if (reads >= result.getUint32(candidate * outputStride + this.stateBytes + 12, true)) continue
				const position = candidate * outputStride + this.stateBytes
				result.setUint32(position, parent, true)
				result.setUint32(position + 4, index, true)
				result.setUint32(position + 8, mask, true)
				result.setUint32(position + 12, reads, true)
			}
		}
		return { candidates: output.slice(0, count * outputStride), count, attempts, expansionMs: performance.now() - started }
	}
}

/** Pack a truth-table state directly, without expanding it into boolean objects. */
export function stateIdentifier(state: Uint8Array, wires: number) {
	return packState(state, wires).toString('hex')
}
