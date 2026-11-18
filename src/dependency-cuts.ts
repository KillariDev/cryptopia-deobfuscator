import { Gate } from './types.js'
import { appendWireAccess, getVars, wireAccessLowerBound } from './utils.js'

export type WireVersion = { wire: number, version: number }
export type DependencyCut = { indices: number[], gates: Gate[], wires: number[], inputs: WireVersion[], outputs: WireVersion[] }
export class CutCancelled extends Error {}

/** Full read/write ordering, including all readers before the next overwrite.
 * Unlike a chunk-local dependency graph, this index spans the supplied circuit. */
export class DependencyCutIndex {
	readonly predecessors: number[][] = []
	readonly successors: number[][] = []
	private readonly writes = new Map<number, number[]>()
	readonly outputSeeds: number[]
	constructor(readonly gates: Gate[], private stopped: () => boolean = () => false) {
		const readers = new Map<number, number[]>()
		for (let i = 0; i < gates.length; i++) {
			this.check()
			const used = getVars(gates[i]).filter((wire, index, wires) => wires.indexOf(wire) === index)
			const target = gates[i].target, previous = new Set<number>()
			for (const wire of used) {
				const writer = this.writes.get(wire)?.at(-1)
				if (writer !== undefined) previous.add(writer)
			}
			for (const reader of readers.get(target) ?? []) { this.check(); previous.add(reader) }
			this.predecessors.push([...previous].sort((a, b) => a - b)); this.successors.push([])
			for (const from of previous) this.successors[from].push(i)
			readers.delete(target); appendWireAccess(this.writes, target, i)
			for (const wire of used) if (wire !== target) appendWireAccess(readers, wire, i)
		}
		this.outputSeeds = [...this.writes.values()].map(lines => lines[lines.length - 1]).sort((a, b) => b - a)
	}
	setStop(stopped: () => boolean) { this.stopped = stopped }
	private check() { if (this.stopped()) throw new CutCancelled('Dependency cut canceled') }
	/** A right-closed region can move to its final selected gate without
	 * crossing any conflicting unselected operation. */
	cut(indices: number[]): DependencyCut | undefined {
		this.check()
		const ordered = [...new Set(indices)].sort((a, b) => a - b)
		if (!ordered.length || ordered.some(i => !Number.isInteger(i) || i < 0 || i >= this.gates.length)) return undefined
		const chosen = new Set(ordered), anchor = ordered[ordered.length - 1]
		for (const i of ordered) for (const next of this.successors[i]) {
			this.check(); if (next > anchor) break
			if (!chosen.has(next)) return undefined
		}
		const inputs = new Map<number, number>(), outputs = new Map<number, number>(), used = new Set<number>()
		for (const i of ordered) {
			this.check()
			for (const wire of getVars(this.gates[i])) {
				const writes = this.writes.get(wire)
				const version = writes ? (writes[wireAccessLowerBound(writes, i) - 1] ?? -1) + 1 : 0
				used.add(wire)
				if (version > 0 && chosen.has(version - 1)) continue
				if (inputs.has(wire) && inputs.get(wire) !== version) return undefined
				inputs.set(wire, version)
			}
			outputs.set(this.gates[i].target, i + 1)
		}
		return { indices: ordered, gates: ordered.map(i => this.gates[i]), wires: [...used].sort((a, b) => a - b), inputs: [...inputs].map(([wire, version]) => ({ wire, version })), outputs: [...outputs].map(([wire, version]) => ({ wire, version })) }
	}
	select(seed: number, maximumGates: number): DependencyCut | undefined {
		this.check()
		if (!Number.isInteger(seed) || seed < 0 || seed >= this.gates.length || maximumGates < 1) return undefined
		const chosen = new Set([seed]), visited = new Set<number>(), frontier = [...this.predecessors[seed]]
		while (frontier.length && chosen.size < maximumGates) {
			this.check()
			const candidate = frontier.pop()!
			if (chosen.has(candidate) || visited.has(candidate)) continue
			visited.add(candidate)
			const pending = new Set<number>(), stack: number[] = []
			const add = (i: number) => { if (!chosen.has(i) && !pending.has(i)) { pending.add(i); stack.push(i) }; return chosen.size + pending.size <= maximumGates }
			let fits = add(candidate)
			while (fits && stack.length) {
				this.check()
				for (const next of this.successors[stack.pop()!]) {
					this.check(); if (next > seed) break
					if (!add(next)) { fits = false; break }
				}
			}
			if (!fits) continue
			for (const i of pending) { chosen.add(i); for (const previous of this.predecessors[i]) if (!chosen.has(previous)) frontier.push(previous) }
		}
		return this.cut([...chosen])
	}
	/** Replacement equivalence is proved by the chosen regional solver. This
	 * method separately proves movement/boundaries and forbids borrowed wires. */
	patch(cut: DependencyCut, replacement: Gate[]): Gate[] {
		const checked = this.cut(cut.indices)
		if (!checked || checked.gates.length !== cut.gates.length || checked.gates.some((gate, i) => gate !== cut.gates[i])) throw new Error('Stale or non-convex dependency cut')
		const wires = new Set(checked.wires)
		for (const gate of replacement) if (getVars(gate).some(wire => !wires.has(wire))) throw new Error('Dependency replacement introduces a boundary wire')
		const chosen = new Set(checked.indices), anchor = checked.indices[checked.indices.length - 1], result: Gate[] = []
		for (let i = 0; i < this.gates.length; i++) {
			this.check()
			if (!chosen.has(i)) result.push(this.gates[i])
			if (i === anchor) for (const gate of replacement) { this.check(); result.push(gate) }
		}
		return result
	}
	/** Interleave region sizes across global output cones and distributed seeds.
	 * Batches keep the working set bounded; search continues until cancellation. */
	*regions(offset = 0, minimum = 2, maximum = this.gates.length): Generator<DependencyCut> {
		const limit = Math.min(maximum, this.gates.length)
		if (limit < minimum || !this.predecessors.some(edges => edges.length)) return
		let cursor = offset % this.gates.length
		const widths = [minimum]
		while (widths[widths.length - 1] < limit) widths.push(Math.min(limit, widths[widths.length - 1] * 2))
		while (!this.stopped()) {
			const seeds = new Set(this.outputSeeds.slice(cursor % this.outputSeeds.length).concat(this.outputSeeds.slice(0, cursor % this.outputSeeds.length)))
			for (let i = 0; i < 32; i++) seeds.add((cursor + Math.floor(i * this.gates.length / 32)) % this.gates.length)
			const seen = new Set<string>()
			let keyBytes = 0, yielded = false
			for (const seed of seeds) for (const width of widths) {
				this.check()
				const cut = this.select(seed, width)
				if (!cut || cut.indices.length < minimum) continue
				const key = cut.indices.join(',')
				if (seen.has(key)) continue
				if (keyBytes + key.length > 1000000) { seen.clear(); keyBytes = 0 }
				seen.add(key); keyBytes += key.length; yielded = true; yield cut
			}
			if (!yielded) return
			cursor = (cursor + 1) % this.gates.length
		}
	}
}

const indexes = new WeakMap<object, { key: string, index: DependencyCutIndex, regions: Generator<DependencyCut> }>()

export type CutSearchStats = { regions: number, solverMs: number }
export async function searchDependencyCuts(input: Gate[], stopped: () => boolean, solve: (cut: DependencyCut) => Promise<Gate[] | undefined>, offset = 0, stats: CutSearchStats = { regions: 0, solverMs: 0 }, cache?: object, minimum = 2, maximum = input.length): Promise<Gate[] | undefined> {
	try {
		const key = cache ? `${minimum}:${maximum}:${JSON.stringify(input)}` : ''
		let entry = cache ? indexes.get(cache) : undefined
		if (!entry || entry.key !== key) {
			const index = new DependencyCutIndex(input, stopped)
			entry = { key, index, regions: index.regions(offset, minimum, maximum) }; if (cache) indexes.set(cache, entry)
		}
		const { index, regions } = entry; index.setStop(stopped)
		while (!stopped()) {
			const next = regions.next(); if(next.done) { if(cache) indexes.delete(cache); break }; const cut = next.value
			stats.regions++
			const started = performance.now(), result = await solve(cut)
			stats.solverMs += performance.now() - started
			if (stopped()) return undefined
			if (result && result.length < cut.gates.length) return index.patch(cut, result)
		}
		return undefined
	} catch (error) { if (error instanceof CutCancelled) return undefined; throw error }
}
