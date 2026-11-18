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

/** Verify/persist before stopping peers, and keep better results returned while draining. */
export class WholeCircuitRestart {
	best: Gate[]
	constructor(initial: Gate[], private stop: Int32Array, private persist: (candidate: Gate[]) => void) { this.best = initial }
	accept(candidate: Gate[]) {
		if (candidate.length >= this.best.length) return false
		this.persist(candidate)
		this.best = candidate
		Atomics.store(this.stop, 0, 1)
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
