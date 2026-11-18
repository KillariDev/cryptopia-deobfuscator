import { Gate, DependencyNode } from './types.js'
import { getVars, dependencyGraphToMap, DependencyContext } from './utils.js'
import { ChunkedSequence } from './chunked-sequence.js'

type Record = { gate: Gate, wires: number[], past: Set<number>, future?: number }
/** Edges use stable gate IDs. Only users of edited wires need edge recomputation. */
export class IncrementalGraph {
	private next = 0
	private order: ChunkedSequence<number>
	private records = new Map<number, Record>()
	private accesses = new Map<number, number[]>()
	private writes = new Map<number, number[]>()
	private cached?: DependencyContext
	constructor(gates: Gate[], chunkSize = 128) {
		this.order = new ChunkedSequence(gates.map(gate => this.add(gate)), chunkSize, true)
		this.initialize()
	}
	private add(gate: Gate) {
		const id = this.next++
		this.records.set(id, { gate, wires: getVars(gate), past: new Set() })
		return id
	}
	private initialize() {
		const append = (index: Map<number, number[]>, wire: number, id: number) => {
			const list = index.get(wire)
			if (!list) index.set(wire, [id])
			else if (list[list.length - 1] !== id) list.push(id)
		}
		const latest = (index: Map<number, number[]>, wire: number) => {
			const list = index.get(wire)
			return list?.[list.length - 1]
		}
		for (const [id, record] of this.records) {
			const target = record.gate.target
			const previous = latest(this.accesses, target)
			if (previous !== undefined) record.past.add(previous)
			for (let i = 1; i < record.wires.length; i++) {
				const writer = latest(this.writes, record.wires[i])
				if (writer !== undefined) record.past.add(writer)
			}
			for (const wire of record.wires) append(this.accesses, wire, id)
			append(this.writes, target, id)
		}
		const nextAccess = new Map<number, number>(), nextWrite = new Map<number, number>()
		// IDs are consecutive and in circuit order during construction.
		for (let id = this.next - 1; id >= 0; id--) {
			const record = this.records.get(id)!
			const target = record.gate.target
			let nearest = nextAccess.get(target) ?? Infinity
			for (let i = 1; i < record.wires.length; i++) nearest = Math.min(nearest, nextWrite.get(record.wires[i]) ?? Infinity)
			record.future = nearest === Infinity ? undefined : nearest
			for (const wire of record.wires) nextAccess.set(wire, id)
			nextWrite.set(target, id)
		}
	}
	private neighbor(list: number[] = [], position: number, future: boolean) {
		let low = 0, high = list.length
		while (low < high) { const mid = (low + high) >>> 1; if (this.order.indexOf(list[mid])! < position + Number(future)) low = mid + 1; else high = mid }
		return future ? list[low] : list[low - 1]
	}
	private recompute(ids: Set<number>) {
		for (const id of ids) {
			const record = this.records.get(id)
			if (!record) continue
			const position = this.order.indexOf(id)!
			record.past.clear()
			let nearest = Infinity
			record.future = undefined
			for (let i = 0; i < record.wires.length; i++) {
				const list = (i === 0 ? this.accesses : this.writes).get(record.wires[i])
				const previous = this.neighbor(list, position, false)
				if (previous !== undefined) record.past.add(previous)
				const next = this.neighbor(list, position, true)
				if (next === undefined) continue
				const nextPosition = this.order.indexOf(next)!
				if (nextPosition < nearest) {
					nearest = nextPosition
					record.future = next
				}
			}
		}
	}
	/** Access-list edits affect adjacent target users. Writes additionally
	 * affect control dependencies between the surrounding writes. */
	private collectAffected(ids: number[], affected: Set<number>) {
		const ranges = new Map<number, [number, number][]>()
		for (const id of ids) {
			const { gate, wires } = this.records.get(id)!
			const position = this.order.indexOf(id)!
			for (let i = 0; i < wires.length; i++) {
				const wire = wires[i]
				if (wires.indexOf(wire) !== i) continue
				const accesses = this.accesses.get(wire)
				const before = this.neighbor(accesses, position, false)
				const after = this.neighbor(accesses, position, true)
				if (before !== undefined) affected.add(before)
				if (after !== undefined) affected.add(after)
			}
			const wire = gate.target
			const before = this.neighbor(this.writes.get(wire), position, false)
			const after = this.neighbor(this.writes.get(wire), position, true)
			const low = before === undefined ? 0 : this.order.indexOf(before)!
			const high = after === undefined ? this.order.length : this.order.indexOf(after)! + 1
			const intervals = ranges.get(wire)
			if (intervals) intervals.push([low, high])
			else ranges.set(wire, [[low, high]])
		}
		for (const [wire, intervals] of ranges) {
			const list = this.accesses.get(wire) ?? []
			const lowerBound = (position: number) => {
				let low = 0, high = list.length
				while (low < high) {
					const mid = (low + high) >>> 1
					if (this.order.indexOf(list[mid])! < position) low = mid + 1
					else high = mid
				}
				return low
			}
			intervals.sort((a, b) => a[0] - b[0])
			let coveredThrough = 0
			for (const [low, high] of intervals) {
				if (high <= coveredThrough) continue
				const end = lowerBound(high)
				for (let i = lowerBound(Math.max(low, coveredThrough)); i < end; i++) affected.add(list[i])
				coveredThrough = high
			}
		}
	}

	replace(selected: number[], replacement: Gate[]) {
		const oldIds = selected.map(index => this.order.at(index))
		const touched = new Set([...oldIds.flatMap(id => this.records.get(id)!.wires), ...replacement.flatMap(getVars)])
		const affected = new Set<number>()
		this.collectAffected(oldIds, affected)
		const newIds = replacement.map(gate => this.add(gate))
		this.order.replace(selected, newIds)
		for (const id of oldIds) this.records.delete(id)
		this.cached = undefined
		const removed = new Set(oldIds)
		for (const wire of touched) {
			const merge = (source: Map<number, number[]>, writes: boolean) => {
				const existing = (source.get(wire) ?? []).filter(id => !removed.has(id))
				const incoming = newIds.filter(id => writes ? this.records.get(id)!.gate.target === wire : this.records.get(id)!.wires.includes(wire))
				if (!incoming.length) { source.set(wire, existing); return }
				const position = this.order.indexOf(incoming[0])!
				let low = 0, high = existing.length
				while (low < high) { const mid = (low + high) >>> 1; if (this.order.indexOf(existing[mid])! < position) low = mid + 1; else high = mid }
				source.set(wire, [...existing.slice(0, low), ...incoming, ...existing.slice(low)])
			}
			merge(this.accesses, false); merge(this.writes, true)
		}
		for (const id of newIds) affected.add(id)
		this.collectAffected(newIds, affected)
		this.recompute(affected)
	}
	context(): DependencyContext {
		if (this.cached) return this.cached
		const nodes: DependencyNode[] = [...this.order].map((id, lineNumber) => {
			const record = this.records.get(id)!
			return { lineNumber, dependOnPastLines: [...record.past].map(id => this.order.indexOf(id)!).sort((a, b) => a - b), dependOnFutureLine: record.future === undefined ? -1 : this.order.indexOf(record.future)! }
		})
		const map = (source: Map<number, number[]>) => new Map([...source].filter(([, ids]) => ids.length > 0).map(([wire, ids]) => [wire, ids.map(id => this.order.indexOf(id)!)]))
		return this.cached = { nodes, dependantMap: dependencyGraphToMap(nodes), access: { accesses: map(this.accesses), writes: map(this.writes) } }
	}
}
