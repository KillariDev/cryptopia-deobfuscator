import type { CutPatch } from './dependency-cuts.js'
import { Gate } from './types.js'
import { isBetterCircuit } from './circuit-cost.js'

import { getRandomNumberInRange } from './utils.js'

export function roundChunkSize(gates: number, minimum: number, maximumFraction: number) {
	const maximum = Math.max(1, Math.floor(gates * maximumFraction))
	return getRandomNumberInRange(Math.min(minimum, maximum), maximum + 1)
}

/** Small circuits use independent full-context searches instead of tiny chunks. */
export function roundSearchPlan(gates: number, maximumWorkers: number, chunkSize: number, wholeCircuitMaximumGates: number) {
	const wholeCircuit = gates > 0 && gates <= wholeCircuitMaximumGates && maximumWorkers > 1
	return { wholeCircuit, capacity: wholeCircuit ? maximumWorkers : Math.max(1, Math.min(Math.floor(gates / chunkSize), maximumWorkers, gates || 1)) }
}

/** Whole-circuit candidates are alternatives; only disjoint chunks may concatenate. */
export function roundSearchResult(candidates: Gate[][], wholeCircuit: boolean): Gate[] {
	if (!wholeCircuit) return candidates.flat()
	if (!candidates.length) throw new Error('No whole-circuit search candidates')
	return candidates.reduce((best, candidate) => isBetterCircuit(candidate, best) ? candidate : best)
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

/** Track original spans across a chain of global cut rewrites. */
export class RoundCutPatches {
	private origins: number[] | undefined
	private patches: { start: number, end: number, replacement: Gate[] }[] = []
	constructor(length: number) {
		this.origins = Array.from({ length }, (_, i) => i)
	}
	observe(input: Gate[], patch?: CutPatch) {
		if (!this.origins) return
		if (!patch) { this.origins = undefined; return }
		const { indices, replacement } = patch
		const first = indices[0], last = indices[indices.length - 1]
		const start = this.origins[first], end = this.origins[last] + 1
		const selected = new Set(indices)
		// Only record spans whose entire input still comes from the baseline.
		if (end - start === last - first + 1 &&
			this.origins.slice(first, last + 1).every((origin, i) => origin === start + i) &&
			this.patches.every(patch => end <= patch.start || start >= patch.end)) {
			this.patches.push({
				start, end,
				replacement: [...input.slice(first, last + 1).filter((_, i) => !selected.has(first + i)), ...replacement],
			})
		}
		this.origins = [...this.origins.slice(0, last + 1).filter((_, i) => !selected.has(i)), ...replacement.map(() => -1), ...this.origins.slice(last + 1)]
	}
	merge(chunks: Gate[][], split: Gate[][]): Gate[] | undefined {
		const edits: { start: number, end: number, replacement: Gate[] }[] = []
		const boundaries = [0], localBoundaries = [0]
		for (let i = 0; i < chunks.length; i++) {
			boundaries.push(boundaries[i] + chunks[i].length)
			localBoundaries.push(localBoundaries[i] + split[i].length)
		}
		for (const patch of this.patches) {
			const chunk = boundaries.findIndex((offset, i) => offset <= patch.start && boundaries[i + 1] > patch.start)
			if (chunk < 0) continue
			let conflict = false
			for (let i = chunk; boundaries[i] < patch.end; i++) if (chunks[i] !== split[i]) { conflict = true; break }
			if (conflict) continue
			const shift = localBoundaries[chunk] - boundaries[chunk]
			edits.push({ start: patch.start + shift, end: patch.end + shift, replacement: patch.replacement })
		}
		if (!edits.length) return undefined
		const local = split.flat(), result: Gate[] = []
		let position = 0
		for (const { start, end, replacement } of edits.sort((a, b) => a.start - b.start)) {
			for (let i = position; i < start; i++) result.push(local[i])
			for (const gate of replacement) result.push(gate)
			position = end
		}
		return result.concat(local.slice(position))
	}
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
