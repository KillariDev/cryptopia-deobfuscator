import { Gate } from './types.js'

const initialStates = new Map<number, Uint32Array>()
/** One evaluation on actual wires; wider tables only extend the untouched inputs. */
export class LookupFunction {
	private values: Uint32Array
	private keys = new Map<number, string>()
	constructor(gates: Gate[], readonly wires: number) {
		if (!Number.isInteger(wires) || wires < 0 || wires > 8) throw new Error('Lookup functions support 0–8 wires')
		const batches = Math.ceil(2 ** wires / 32)
		let initial = initialStates.get(wires)
		if (!initial) {
			initial = new Uint32Array(batches * wires)
			for (let input = 0; input < 2 ** wires; input++) for (let wire = 0; wire < wires; wire++) if (input & 1 << wire) initial[Math.floor(input / 32) * wires + wire] |= 1 << (input & 31)
			initialStates.set(wires, initial)
		}
		this.values = initial.slice()
		for (const gate of gates) for (let batch = 0; batch < batches; batch++) {
			const offset = batch * wires, a = this.values[offset + gate.a], b = this.values[offset + gate.b], f = gate.gate_i
			const control = ((f & 8) ? ~a & ~b : 0) | ((f & 4) ? ~a & b : 0) | ((f & 2) ? a & ~b : 0) | ((f & 1) ? a & b : 0)
			this.values[offset + gate.target] ^= control
		}
	}
	key(tableWires: number) {
		if (!Number.isInteger(tableWires) || tableWires < this.wires || tableWires > 8) throw new Error('Invalid lookup table width')
		const cached = this.keys.get(tableWires)
		if (cached !== undefined) return cached
		const bytes = Buffer.alloc(Math.ceil(2 ** tableWires * tableWires / 8)), mask = 2 ** this.wires - 1
		for (let input = 0; input < 2 ** tableWires; input++) {
			const actual = input & mask, offset = Math.floor(actual / 32) * this.wires
			for (let wire = 0; wire < tableWires; wire++) {
				const value = wire < this.wires ? this.values[offset + wire] >>> (actual & 31) & 1 : input >>> wire & 1
				const bit = input * tableWires + wire
				bytes[bit >>> 3] |= value << (bit & 7)
			}
		}
		const key = bytes.toString('hex'); this.keys.set(tableWires, key)
		return key
	}
}
