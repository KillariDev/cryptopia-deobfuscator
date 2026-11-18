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
