import { Gate, DependencyNode } from './types.js'
import { getVars, DependencyContext } from './utils.js'
import { ChunkedSequence } from './chunked-sequence.js'

type WireEdit = { firstRemoval: number, incoming: number[] }

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
	private lowerBound(list: readonly number[], position: number) {
		let low = 0, high = list.length
		while (low < high) {
			const mid = (low + high) >>> 1
			if (this.order.indexOf(list[mid])! < position) low = mid + 1
			else high = mid
		}
		return low
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
				if (!list) continue
				const at = this.lowerBound(list, position)
				const previous = list[at - 1]
				if (previous !== undefined) record.past.add(previous)
				const next = list[list[at] === id ? at + 1 : at]
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
				const accesses = this.accesses.get(wire)!
				const at = this.lowerBound(accesses, position)
				const before = accesses[at - 1]
				const after = accesses[at + 1]
				if (before !== undefined) affected.add(before)
				if (after !== undefined) affected.add(after)
			}
			const wire = gate.target
			const writes = this.writes.get(wire)!
			const at = this.lowerBound(writes, position)
			const before = writes[at - 1]
			const after = writes[at + 1]
			const low = before === undefined ? 0 : this.order.indexOf(before)!
			const high = after === undefined ? this.order.length : this.order.indexOf(after)! + 1
			const intervals = ranges.get(wire)
			if (intervals) intervals.push([low, high])
			else ranges.set(wire, [[low, high]])
		}
		for (const [wire, intervals] of ranges) {
			const list = this.accesses.get(wire) ?? []

			intervals.sort((a, b) => a[0] - b[0])
			let coveredThrough = 0
			for (const [low, high] of intervals) {
				if (high <= coveredThrough) continue
				const end = this.lowerBound(list, high)
				for (let i = this.lowerBound(list, Math.max(low, coveredThrough)); i < end; i++) affected.add(list[i])
				coveredThrough = high
			}
		}
	}

	private updateWireLists(
		index: Map<number, number[]>, edits: Map<number, WireEdit>, removed: Set<number>,
	) {
		for (const [wire, { firstRemoval, incoming }] of edits) {
			const list = index.get(wire) ?? []
			let kept = Math.min(firstRemoval, list.length)
			for (let i = kept; i < list.length; i++) {
				const id = list[i]
				if (!removed.has(id)) list[kept++] = id
			}
			list.length = kept
			if (incoming.length) {
				const start = this.lowerBound(list, this.order.indexOf(incoming[0])!)
				for (let i = kept - 1; i >= start; i--) list[i + incoming.length] = list[i]
				for (let i = 0; i < incoming.length; i++) list[start + i] = incoming[i]
			}
			if (list.length) index.set(wire, list)
			else index.delete(wire)
		}
	}

	replace(selected: number[], replacement: Gate[]) {
		const oldIds = selected.map(index => this.order.at(index))
		const affected = new Set<number>()
		this.collectAffected(oldIds, affected)
		const newIds = replacement.map(gate => this.add(gate))
		const accessEdits = new Map<number, WireEdit>(), writeEdits = new Map<number, WireEdit>()
		const editFor = (edits: Map<number, WireEdit>, wire: number) => {
			let edit = edits.get(wire)
			if (!edit) {
				edit = { firstRemoval: Infinity, incoming: [] }
				edits.set(wire, edit)
			}
			return edit
		}
		const markRemoval = (edits: Map<number, WireEdit>, wire: number, position: number) => {
			const edit = editFor(edits, wire)
			edit.firstRemoval = Math.min(edit.firstRemoval, position)
		}
		for (let i = 0; i < oldIds.length; i++) {
			const { gate, wires } = this.records.get(oldIds[i])!
			for (const wire of wires) markRemoval(accessEdits, wire, selected[i])
			markRemoval(writeEdits, gate.target, selected[i])
		}
		// The lists still use the old circuit order here.
		for (const [wire, edit] of accessEdits) edit.firstRemoval = this.lowerBound(this.accesses.get(wire)!, edit.firstRemoval)
		for (const [wire, edit] of writeEdits) edit.firstRemoval = this.lowerBound(this.writes.get(wire)!, edit.firstRemoval)
		for (const id of newIds) {
			const { gate, wires } = this.records.get(id)!
			for (const wire of wires) {
				const { incoming } = editFor(accessEdits, wire)
				if (incoming[incoming.length - 1] !== id) incoming.push(id)
			}
			editFor(writeEdits, gate.target).incoming.push(id)
			affected.add(id)
		}
		this.order.replace(selected, newIds)
		for (const id of oldIds) this.records.delete(id)
		this.cached = undefined
		const removed = new Set(oldIds)
		this.updateWireLists(this.accesses, accessEdits, removed)
		this.updateWireLists(this.writes, writeEdits, removed)
		this.collectAffected(newIds, affected)
		this.recompute(affected)
	}
	context(): DependencyContext {
		if (this.cached) return this.cached
		const nodes: DependencyNode[] = []
		const dependantMap = new Map<number, number[]>()
		for (const id of this.order) {
			const record = this.records.get(id)!
			const past: number[] = []
			for (const dependency of record.past) past.push(this.order.indexOf(dependency)!)
			past.sort((a, b) => a - b)
			const lineNumber = nodes.length
			for (const dependency of past) {
				const dependants = dependantMap.get(dependency)
				if (dependants) dependants.push(lineNumber)
				else dependantMap.set(dependency, [lineNumber])
			}
			nodes.push({
				lineNumber,
				dependOnPastLines: past,
				dependOnFutureLine: record.future === undefined ? -1 : this.order.indexOf(record.future)!,
			})
		}
		const map = (source: Map<number, number[]>) => {
			const positions = new Map<number, number[]>()
			for (const [wire, ids] of source) {
				if (ids.length) positions.set(wire, ids.map(id => this.order.indexOf(id)!))
			}
			return positions
		}
		return this.cached = { nodes, dependantMap, access: { accesses: map(this.accesses), writes: map(this.writes) } }
	}
}
