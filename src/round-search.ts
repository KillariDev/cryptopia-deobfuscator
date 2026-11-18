import { Gate } from './types.js'
import { improving } from './search.js'

/** Small circuits use independent full-context searches instead of tiny chunks. */
export function roundSearchPlan(gates: number, maximumWorkers: number, chunkSize: number, wholeCircuitMaximumGates: number) {
	const wholeCircuit = gates > 0 && gates <= wholeCircuitMaximumGates && maximumWorkers > 1
	return { wholeCircuit, capacity: wholeCircuit ? maximumWorkers : Math.max(1, Math.min(Math.floor(gates / chunkSize), maximumWorkers, gates || 1)) }
}

/** Whole-circuit candidates are alternatives; only disjoint chunks may concatenate. */
export function roundSearchResult(candidates: Gate[][], wholeCircuit: boolean): Gate[] {
	if (!wholeCircuit) return candidates.flat()
	if (!candidates.length) throw new Error('No whole-circuit search candidates')
	return candidates.reduce((best, candidate) => improving(best)(candidate) ? candidate : best)
}

/** Merge a single global splice whose original span is unchanged by local work.
 * Prove the splice on arbitrary inputs before applying it between local chunks. */
export function mergeDisjointRoundResults(original: Gate[], chunks: Gate[][], split: Gate[][], global: Gate[], prove: (before: Gate[], after: Gate[]) => boolean): Gate[] | undefined {
	if (global.length >= original.length) return undefined
	const same = (a: Gate, b: Gate) => a === b || (a.a === b.a && a.b === b.b && a.target === b.target && a.gate_i === b.gate_i)
	let start = 0
	while (start < global.length && same(original[start], global[start])) start++
	let end = original.length, globalEnd = global.length
	while (globalEnd > start && same(original[end - 1], global[globalEnd - 1])) { end--; globalEnd-- }
	let originalOffset = 0, localOffset = 0, localStart = -1
	for (let i = 0; i < chunks.length && originalOffset < end; i++) {
		const next = originalOffset + chunks[i].length
		if (next > start) {
			if (chunks[i] !== split[i]) return undefined
			if (localStart < 0) localStart = localOffset + start - originalOffset
		}
		originalOffset = next
		localOffset += split[i].length
	}
	if (localStart < 0 || !prove(original.slice(start, end), global.slice(start, globalEnd))) return undefined
	const local = split.flat()
	return [...local.slice(0, localStart), ...global.slice(start, globalEnd), ...local.slice(localStart + end - start)]
}

/** Verify/persist before stopping peers, and keep better results returned while draining. */
export class WholeCircuitRestart {
	best: Gate[]
	constructor(initial: Gate[], private stop: Int32Array, private persist: (candidate: Gate[]) => void) { this.best = initial }
	accept(candidate: Gate[], stopPeers = true) {
		if (candidate.length >= this.best.length) return false
		this.persist(candidate)
		this.best = candidate
		if (stopPeers) Atomics.store(this.stop, 0, 1)
		return true
	}
}

/** Reserve occasional broad-strategy turns without repeating them on fast restarts. */
export class PeriodicStrategy {
	private next = -Infinity
	constructor(private intervalMs: number) {}
	retry() { this.next = -Infinity }
	take(now: number) {
		if (this.intervalMs <= 0 || now < this.next) return false
		this.next = now + this.intervalMs
		return true
	}
}
