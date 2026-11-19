import type { Gate } from './types.js'
import { getVars } from './utils.js'

function wireUsage(gates: Gate[]) {
	const counts = new Map<string, number>()
	let operands = 0, pairUses = 0, squaredCounts = 0
	for (const gate of gates) {
		const wires = getVars(gate).filter((wire, i, used) => used.indexOf(wire) === i)
		operands += wires.length
		for (let i = 0; i < wires.length; i++) {
			for (let j = i + 1; j < wires.length; j++) {
				const a = Math.min(wires[i], wires[j]), b = Math.max(wires[i], wires[j])
				const key = `${a}:${b}`
				const previous = counts.get(key) ?? 0
				counts.set(key, previous + 1)
				pairUses++
				squaredCounts += 2 * previous + 1
			}
		}
	}
	return { operands, pairUses, squaredCounts, counts }
}

const effectivePairs = (uses: number, squared: number) => uses ? uses ** 2 / squared : 0

/** Gate order has no effect on operand or pair frequencies. */
export function circuitWireCost(gates: Gate[]) {
	const { operands, pairUses, squaredCounts } = wireUsage(gates)
	return { operands, effectivePairs: effectivePairs(pairUses, squaredCounts) }
}

/** Rank a replacement against the complete split circuit. Build the pair
 * histogram only when an equal-sized candidate needs a tie-break. */
export class SplitCircuitCost {
	private usage?: ReturnType<typeof wireUsage>[]
	private counts = new Map<string, number>()
	private pairUses = 0
	private squaredCounts = 0

	constructor(private chunks: Gate[][]) {}

	accept(index: number, candidate: Gate[]): boolean {
		const current = this.chunks[index]
		if (candidate === current || candidate.length > current.length) return false
		if (!this.usage && candidate.length === current.length) {
			this.usage = this.chunks.map(wireUsage)
			for (const part of this.usage) {
				this.pairUses += part.pairUses
				for (const [key, count] of part.counts) {
					const previous = this.counts.get(key) ?? 0
					this.counts.set(key, previous + count)
					this.squaredCounts += count * (2 * previous + count)
				}
			}
		}
		if (this.usage) {
			const before = this.usage[index]
			const after = wireUsage(candidate)
			if (candidate.length === current.length && after.operands > before.operands) return false
			const changes = new Map<string, number>()
			for (const [key, count] of before.counts) changes.set(key, -count)
			for (const [key, count] of after.counts) changes.set(key, (changes.get(key) ?? 0) + count)
			const pairUses = this.pairUses + after.pairUses - before.pairUses
			let squaredCounts = this.squaredCounts
			for (const [key, change] of changes) squaredCounts += change * (2 * (this.counts.get(key) ?? 0) + change)
			if (candidate.length === current.length && before.operands === after.operands &&
				effectivePairs(pairUses, squaredCounts) >= effectivePairs(this.pairUses, this.squaredCounts)) return false
			for (const [key, change] of changes) {
				const count = (this.counts.get(key) ?? 0) + change
				if (count) this.counts.set(key, count)
				else this.counts.delete(key)
			}
			this.squaredCounts = squaredCounts
			this.pairUses = pairUses
			this.usage[index] = after
		}
		this.chunks[index] = candidate
		return true
	}
}

/** With equal gate counts, total operands and mean operands order identically. */
export function isBetterCircuit(candidate: Gate[], baseline: Gate[]) {
	if (candidate.length !== baseline.length) return candidate.length < baseline.length
	if (candidate === baseline) return false
	const next = circuitWireCost(candidate), previous = circuitWireCost(baseline)
	return next.operands !== previous.operands ? next.operands < previous.operands : next.effectivePairs < previous.effectivePairs
}
