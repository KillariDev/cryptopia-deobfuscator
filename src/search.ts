import { Gate } from './types.js'
import { gateControlMask, getVars, hashGates, reverseMapCircuit } from './utils.js'
import { LimitedMap } from './limitedMap.js'

/** First-use renaming preserves gate order and control function orientation. */
export function normalizeWindow(gates: Gate[]) {
	const wires: number[] = []
	const indices = new Map<number, number>()
	const indexOf = (wire: number) => {
		let index = indices.get(wire)
		if (index === undefined) {
			index = wires.length
			wires.push(wire)
			indices.set(wire, index)
		}
		return index
	}
	const normalized = gates.map(gate => {
		const controls = gateControlMask(gate)
		const target = indexOf(gate.target)
		const a = controls & 1 ? indexOf(gate.a) : 0
		const b = controls & 2 ? indexOf(gate.b) : 0
		return { a, b, target, gate_i: gate.gate_i }
	})
	return { wires, normalized, key: hashGates(normalized) }
}
export class RewriteCache {
	private cache: LimitedMap<string, Gate[] | null>
	constructor(entries: number) { this.cache = new LimitedMap(entries) }
	resolve(gates: Gate[], compute: (normalized: Gate[]) => Gate[] | undefined) {
		const { wires, normalized, key } = normalizeWindow(gates)
		let result = this.cache.get(key)
		if (result === undefined) {
			result = compute(normalized) ?? null
			this.cache.set(key, result)
		}
		return result === null ? undefined : reverseMapCircuit(result, wires)
	}
}
export const improving = (old: Gate[], wireCount?: number) => {
	const score = (gates: Gate[]) => {
		const wires = new Set<number>()
		let reads = 0
		for (const gate of gates) {
			const used = getVars(gate)
			reads += used.length
			for (const wire of used) wires.add(wire)
		}
		return { wires: wires.size, reads }
	}
	// Mapped windows can reuse an epoch-stamped wire table between candidates.
	const seen = wireCount === undefined ? undefined : new Uint32Array(wireCount)
	let epoch = 0
	const denseScore = (gates: Gate[]) => {
		if (!seen) return score(gates)
		if (epoch === 0xffffffff) {
			seen.fill(0)
			epoch = 0
		}
		epoch++
		let wires = 0, reads = 0
		for (const gate of gates) {
			const controls = gateControlMask(gate)
			if (seen[gate.target] === undefined) return score(gates)
			if (seen[gate.target] !== epoch) {
				seen[gate.target] = epoch
				wires++
			}
			reads++
			if (controls & 1) {
				if (seen[gate.a] === undefined) return score(gates)
				if (seen[gate.a] !== epoch) {
					seen[gate.a] = epoch
					wires++
				}
				reads++
			}
			if (controls & 2) {
				if (seen[gate.b] === undefined) return score(gates)
				if (seen[gate.b] !== epoch) {
					seen[gate.b] = epoch
					wires++
				}
				reads++
			}
		}
		return { wires, reads }
	}
	const baseline = denseScore(old)
	return (candidate: Gate[]) => {
		if (candidate.length !== old.length) return candidate.length < old.length
		const next = denseScore(candidate)
		return next.wires !== baseline.wires ? next.wires < baseline.wires : next.reads < baseline.reads
	}
}

export type SearchArm = { subset: number, slice: number, method?: 'all' | 'variable-elimination' | 'truth-table-lookup' }
type Score = { count: number, milliseconds: number, removed: number, epoch: number }
export class SearchScheduler {
	private scores = new Map<string, Score>()
	private choices = 0
	private epoch = 0
	get historySize() { return this.scores.size }
	constructor(private explorationEvery: number, private decay = 0.98, private maximumHistory = 128) {
		if (!Number.isSafeInteger(maximumHistory) || maximumHistory < 1) throw new Error('Invalid scheduler history limit')
		if (!(decay > 0 && decay <= 1)) throw new Error('Invalid scheduler decay')
	}
	choose(options: SearchArm[], random = Math.random) {
		this.choices++
		const key = (x: SearchArm) => `${x.subset}:${x.slice}:${x.method ?? 'all'}`
		const explore = this.choices % this.explorationEvery === 0
		const untried = options.filter(x => !this.scores.has(key(x)))
		if (!options.length) throw new Error('No search options')
		if (explore || untried.length === options.length) {
			const pool = untried.length ? untried : options
			return pool[Math.floor(random() * pool.length)]
		}
		return options.reduce((best, x) => {
			const rate = (o: typeof x) => { const score = this.scores.get(key(o)); return score ? score.removed / Math.max(1e-9, score.milliseconds) : -1 }
			return rate(x) > rate(best) ? x : best
		})
	}
	record(option: SearchArm, elapsed: number, removed: number) {
		const epoch = ++this.epoch
		const key = `${option.subset}:${option.slice}:${option.method ?? 'all'}`
		const score = this.scores.get(key) ?? { count: 0, milliseconds: 0, removed: 0, epoch }
		const factor = this.decay ** (epoch - score.epoch)
		score.count *= factor; score.milliseconds *= factor; score.removed *= factor; score.epoch = epoch
		this.scores.delete(key)
		if (this.scores.size >= this.maximumHistory) this.scores.delete(this.scores.keys().next().value!)
		score.count++
		score.milliseconds += Math.max(1e-9, elapsed)
		score.removed += Math.max(0, removed)
		this.scores.set(key, score)
	}
}

/** Stable, bounded choices keep persistent worker observations relevant across jobs. */
export function createSearchArms(count: number, subsetMinimum: number, subsetMaximum: number, sliceMinimum: number, sliceMaximum: number): SearchArm[] {
	return Array.from({ length: count }, (_, index) => {
		const step = Math.floor(index / 3), steps = Math.max(1, Math.ceil(count / 3) - 1)
		const subset = Math.round(subsetMinimum * (subsetMaximum / subsetMinimum) ** (step / steps))
		const maximum = Math.min(sliceMaximum, subset)
		const slice = Math.max(sliceMinimum, Math.round(sliceMinimum * (Math.max(sliceMinimum, maximum) / sliceMinimum) ** ((step % 3 + 1) / 3)))
		return { method: (['all', 'variable-elimination', 'truth-table-lookup'] as const)[index % 3], subset, slice }
	})
}

/** Gates in different components use disjoint wires and commute with one another. */
export function independentComponents(gates: Gate[]): Gate[][] {
	const parents = new Map<number, number>()
	const root = (wire: number): number => {
		if (!parents.has(wire)) parents.set(wire, wire)
		let current = wire
		while (parents.get(current)! !== current) current = parents.get(current)!
		while (wire !== current) { const next = parents.get(wire)!; parents.set(wire, current); wire = next }
		return current
	}
	for (const gate of gates) for (const wire of getVars(gate)) {
		const a = root(gate.target), b = root(wire)
		if (a !== b) parents.set(b, a)
	}
	const components = new Map<number, Gate[]>()
	for (const gate of gates) {
		const key = root(gate.target), component = components.get(key) ?? []
		component.push(gate); components.set(key, component)
	}
	return [...components.values()]
}

/** Space worker anchors around the circuit without depending on pool size. */
export function workerRegionSeed(length: number, workerIndex: number) {
	return Math.floor(length * ((workerIndex * 0.61803398875) % 1))
}

/** Index seeds are rebuilt after each edit; broad traversal periodically goes first. */
export class NeighborhoodQueue {
	private seeds: number[] = []
	private rounds = 0
	constructor(private maximum: number, private radius: number, private broadEvery: number) {}
	afterRewrite(start: number, length: number, total: number) {
		this.seeds = []
		const anchors = [Math.min(start, Math.max(0, total - 1)), Math.min(start + Math.max(0, length - 1), Math.max(0, total - 1))]
		const seen = new Set<number>()
		for (let distance = 0; distance <= this.radius && this.seeds.length < this.maximum; distance++) {
			for (const index of anchors.flatMap(anchor => distance ? [anchor - distance, anchor + distance] : [anchor])) {
				if (index >= 0 && index < total && !seen.has(index) && this.seeds.length < this.maximum) { this.seeds.push(index); seen.add(index) }
			}
		}
	}
	take() {
		const seeds = this.seeds; this.seeds = []
		return ++this.rounds % this.broadEvery === 0 ? [] : seeds
	}
}

/** Contiguous chunks preserve circuit order; costs include measured history. */
export function balancedChunks(gates: Gate[], count: number, wireCosts: Map<number, number> = new Map()) {
	if (!gates.length) return []
	count = Math.max(1, Math.min(count, gates.length))
	const meanCost = wireCosts.size ? [...wireCosts.values()].reduce((sum, cost) => sum + cost, 0) / wireCosts.size : 1
	const weights = gates.map((gate, index) => {
		const wires = new Set(getVars(gate))
		const previous = index ? new Set(getVars(gates[index - 1])) : new Set<number>()
		const overlap = [...wires].filter(wire => previous.has(wire)).length
		const measured = [...wires].reduce((sum, wire) => sum + (wireCosts.get(wire) ?? meanCost), 0) / wires.size
		return (wires.size + overlap) * Math.max(0.25, Math.min(4, measured / Math.max(0.001, meanCost)))
	})
	const chunks: Gate[][] = []
	let start = 0, remaining = weights.reduce((a, b) => a + b, 0)
	for (let part = 0; part < count - 1; part++) {
		const target = remaining / (count - part)
		let cost = 0, end = start
		while (end < gates.length - (count - part - 1) && cost < target) cost += weights[end++]
		chunks.push(gates.slice(start, end))
		remaining -= cost
		start = end
	}
	chunks.push(gates.slice(start))
	return chunks
}
