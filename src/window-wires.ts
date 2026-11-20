import { Gate } from './types.js'
import { gateControlMask } from './utils.js'

/** Maintains used-wire counts before allocating a slice or a normalized mapping. */
export class SlidingWindowWires {
	private counts = new Map<number, number>()
	start = -1
	constructor(private gates: Gate[], private length: number) {
		if (!Number.isInteger(length) || length < 1) throw new Error('Invalid window length')
	}
	get end() { return this.start + this.length }
	get wireCount() { return this.counts.size }
	mapping() { return [...this.counts.keys()].sort((a, b) => a - b) }
	private update(wire: number, change: number) {
		const count = (this.counts.get(wire) ?? 0) + change
		if (count) this.counts.set(wire, count)
		else this.counts.delete(wire)
	}
	private add(gate: Gate, change: number) {
		const controls = gateControlMask(gate)
		this.update(gate.target, change)
		if (controls & 1) this.update(gate.a, change)
		if (controls & 2) this.update(gate.b, change)
	}
	next() {
		if (this.start + 1 + this.length > this.gates.length) return false
		if (this.start === -1) for (let i = 0; i < this.length; i++) this.add(this.gates[i], 1)
		else { this.add(this.gates[this.start], -1); this.add(this.gates[this.end], 1) }
		this.start++
		return true
	}
}
