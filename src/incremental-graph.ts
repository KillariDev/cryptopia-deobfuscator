import { Gate, DependencyNode } from './types.js'
import { getVars, appendWireAccess, wireAccessLowerBound, DependencyContext, DependencyQueries, dependencyQueries, selectDependencyRegion } from './utils.js'
import { ChunkedSequence } from './chunked-sequence.js'

type WireEdit = { firstRemoval: number, lastRemoval: number, incoming: number[] }

type Record = { gate: Gate, wires: number[], past0?: number, past1?: number, past2?: number, future?: number }
/** Edges use stable gate IDs. Only users of edited wires need edge recomputation. */
export class IncrementalGraph {
	private next = 0
	private order: ChunkedSequence<number>
	private records = new Map<number, Record>()
	private accesses = new Map<number, number[]>()
	private writes = new Map<number, number[]>()
	private cached?: DependencyContext
	private readonly trackFuture: boolean
	constructor(gates: Gate[], chunkSize = 128, { trackFuture = true }: { trackFuture?: boolean } = {}) {
		this.trackFuture = trackFuture
		for (const gate of gates) this.add(gate)
		this.order = ChunkedSequence.consecutiveIds(gates.length, chunkSize)
		this.initialize()
	}
	private add(gate: Gate) {
		const id = this.next++
		this.records.set(id, { gate, wires: getVars(gate), past0: undefined, past1: undefined, past2: undefined, future: undefined })
		return id
	}
	// Each gate contributes at most three predecessor candidates: its target
	// and up to two controls. Store the distinct IDs directly on the record.
	private addPast(record: Record, id: number) {
		if (record.past0 === undefined) record.past0 = id
		else if (record.past0 === id || record.past1 === id) return
		else if (record.past1 === undefined) record.past1 = id
		else record.past2 = id
	}

	private initialize() {

		const latest = (index: Map<number, number[]>, wire: number) => {
			const list = index.get(wire)
			return list?.[list.length - 1]
		}
		let line = 0
		for (const record of this.records.values()) {
			const id = line++
			const target = record.gate.target
			const previous = latest(this.accesses, target)
			if (previous !== undefined) this.addPast(record, previous)
			for (let i = 1; i < record.wires.length; i++) {
				const writer = latest(this.writes, record.wires[i])
				if (writer !== undefined) this.addPast(record, writer)
			}
			for (const wire of record.wires) appendWireAccess(this.accesses, wire, id)
			appendWireAccess(this.writes, target, id)
		}
		// Local region selection resolves future conflicts from the wire indexes.
		if (!this.trackFuture) return
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
	private readonly positionOf = (id: number) => this.order.indexOf(id)!
	private lowerBound(list: readonly number[], position: number) {
		return wireAccessLowerBound(list, position, this.positionOf)
	}
	private recompute(ids: Set<number>) {
		for (const id of ids) {
			const record = this.records.get(id)
			if (!record) continue
			const position = this.order.indexOf(id)!
			record.past0 = record.past1 = record.past2 = undefined
			let nearest = Infinity
			record.future = undefined
			for (let i = 0; i < record.wires.length; i++) {
				const list = (i === 0 ? this.accesses : this.writes).get(record.wires[i])
				if (!list) continue
				const at = this.lowerBound(list, position)
				const previous = list[at - 1]
				if (previous !== undefined) this.addPast(record, previous)
				if (!this.trackFuture) continue
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
		for (const [wire, { firstRemoval, lastRemoval, incoming }] of edits) {
			const list = index.get(wire) ?? []
			let kept = Math.min(firstRemoval, list.length)
			const end = Math.min(lastRemoval + 1, list.length)
			for (let i = kept; i < end; i++) {
				const id = list[i]
				if (!removed.has(id)) list[kept++] = id
			}
			if (kept < end) {
				for (let i = end; i < list.length; i++) list[kept++] = list[i]
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
				edit = { firstRemoval: Infinity, lastRemoval: -1, incoming: [] }
				edits.set(wire, edit)
			}
			return edit
		}
		const markRemoval = (edits: Map<number, WireEdit>, wire: number, position: number) => {
			const edit = editFor(edits, wire)
			edit.firstRemoval = Math.min(edit.firstRemoval, position)
			edit.lastRemoval = Math.max(edit.lastRemoval, position)
		}
		for (let i = 0; i < oldIds.length; i++) {
			const { gate, wires } = this.records.get(oldIds[i])!
			for (const wire of wires) markRemoval(accessEdits, wire, selected[i])
			markRemoval(writeEdits, gate.target, selected[i])
		}
		// The lists still use the old circuit order here.
		const locateRemovals = (index: Map<number, number[]>, edits: Map<number, WireEdit>) => {
			for (const [wire, edit] of edits) {
				const list = index.get(wire)!
				edit.firstRemoval = this.lowerBound(list, edit.firstRemoval)
				edit.lastRemoval = this.lowerBound(list, edit.lastRemoval)
			}
		}
		locateRemovals(this.accesses, accessEdits)
		locateRemovals(this.writes, writeEdits)
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
	/** Resolve edges against the current order only when a region visits them. */
	private readonly queries: DependencyQueries = {
		past: line => {
			const { past0, past1, past2 } = this.records.get(this.order.at(line))!
			const result: number[] = []
			if (past0 !== undefined) result.push(this.order.indexOf(past0)!)
			if (past1 !== undefined) result.push(this.order.indexOf(past1)!)
			if (past2 !== undefined) result.push(this.order.indexOf(past2)!)
			return result
		},
		lastConflict: (line, before, selected) => {
			const { wires } = this.records.get(this.order.at(line))!
			let last = line
			for (let i = 0; i < wires.length; i++) {
				const list = (i === 0 ? this.accesses : this.writes).get(wires[i])
				if (!list) continue
				for (let at = this.lowerBound(list, before) - 1; at >= 0; at--) {
					const position = this.order.indexOf(list[at])!
					if (position <= last) break
					if (!selected.has(position)) { last = position; break }
				}
			}
			return last === line ? -1 : last
		},
		followers: (line, before, selected) => {
			const id = this.order.at(line)
			const { wires } = this.records.get(id)!
			const followers = new Set<number>()
			for (const wire of wires) {
				const list = this.accesses.get(wire)!
				const start = this.lowerBound(list, line + 1)
				for (let i = start; i < list.length; i++) {
					const next = this.records.get(list[i])!
					const position = this.order.indexOf(list[i])!
					if (position >= before) break
					if (!selected.has(position) && (next.past0 === id || next.past1 === id || next.past2 === id)) followers.add(position)
					// For a read, only the immediately following access can
					// depend on it. For a write, readers can depend on it
					// until the next write.
					if (wire !== wires[0] || next.gate.target === wire) break
				}
			}
			return [...followers]
		},
	}

	selectRegion(anchor: number, size: number, stopped?: () => boolean) {
		return selectDependencyRegion(this.queries, anchor, size, stopped)
	}

	*regions(size: number, preferredWires: ReadonlySet<number> | undefined, seeds: number[], stopped: () => boolean) {
		const visited = new Set<number>()
		let queries = this.queries
		const choose = (line: number) => {
			if (line < 0 || line >= this.order.length || visited.has(line)) return undefined
			visited.add(line)
			// Amortize the dense context on long scans. Early candidates
			// usually only need the stable indexes.
			if (visited.size === 33) {
				const { nodes, dependantMap, access } = this.context()
				const gates = { length: this.order.length, at: (index: number) => this.records.get(this.order.at(index))!.gate }
				queries = dependencyQueries(dependantMap, nodes, gates, access)
			}
			const region = selectDependencyRegion(queries, line, size, stopped)
			return region.length >= size ? region : undefined
		}
		for (const seed of seeds) {
			if (stopped()) return
			const region = choose(seed)
			if (region) yield region
		}
		if (preferredWires?.size) {
			// Follow changed wires to the nearest accesses on either side of
			// the patch, preferring repeated operations among those neighbors.
			const nearby: { line: number, key: string }[] = []
			const frequencies = new Map<string, number>()
			const sampled = new Set<number>()
			for (const wire of preferredWires) {
				if (stopped()) return
				const list = this.accesses.get(wire) ?? []
				const start = seeds.length ? Math.max(0, this.lowerBound(list, seeds[0]) - 2) : Math.floor(Math.random() * list.length)
				for (let i = 0; i < Math.min(4, seeds.length ? list.length - start : list.length) && nearby.length < 32; i++) {
					const id = list[(start + i) % list.length]
					if (sampled.has(id)) continue
					sampled.add(id)
					const { gate } = this.records.get(id)!
					const key = `${gate.gate_i}:${gate.a}:${gate.b}:${gate.target}`
					nearby.push({ line: this.order.indexOf(id)!, key })
					frequencies.set(key, (frequencies.get(key) ?? 0) + 1)
				}
				if (nearby.length >= 32) break
			}
			nearby.sort((a, b) => frequencies.get(b.key)! - frequencies.get(a.key)!)
			for (const { line } of nearby) {
				if (stopped()) return
				const region = choose(line)
				if (region) yield region
			}
		}
		// Draw a random permutation lazily, so early wins need no full shuffle.
		const swaps = new Map<number, number>()
		for (let remaining = this.order.length; remaining > 0; remaining--) {
			if (stopped()) return
			const index = Math.floor(Math.random() * remaining)
			const line = swaps.get(index) ?? index
			swaps.set(index, swaps.get(remaining - 1) ?? remaining - 1)
			swaps.delete(remaining - 1)
			const region = choose(line)
			if (region) yield region
		}
	}

	context(): DependencyContext {
		if (this.cached) return this.cached
		const length = this.order.length
		const fresh = this.next === length
		// Before the first edit, each stable ID is already its line number.
		const ids = fresh ? this.order : [...this.order]
		// Bound temporary storage when many stable IDs have been retired.
		const byId = !fresh && this.next <= length * 2 ? new Uint32Array(this.next) : undefined
		if (byId) {
			let line = 0
			for (const id of ids) byId[id] = line++
		}
		const positionOf = (id: number) => fresh ? id : byId ? byId[id] : this.order.indexOf(id)!
		const nodes: DependencyNode[] = []
		const dependantMap = new Map<number, number[]>()
		for (const id of ids) {
			const record = this.records.get(id)!
			const past: number[] = []
			if (record.past0 !== undefined) past.push(positionOf(record.past0))
			if (record.past1 !== undefined) past.push(positionOf(record.past1))
			if (record.past2 !== undefined) past.push(positionOf(record.past2))
			// At most three entries. Avoid invoking the generic array sort.
			if (past.length > 1 && past[0] > past[1]) {
				const first = past[0]
				past[0] = past[1]
				past[1] = first
			}
			if (past.length === 3 && past[1] > past[2]) {
				const last = past[2]
				past[2] = past[1]
				if (past[0] > last) {
					past[1] = past[0]
					past[0] = last
				} else past[1] = last
			}
			const lineNumber = nodes.length
			for (const dependency of past) {
				const dependants = dependantMap.get(dependency)
				if (dependants) dependants.push(lineNumber)
				else dependantMap.set(dependency, [lineNumber])
			}
			nodes.push({
				lineNumber,
				dependOnPastLines: past,
				dependOnFutureLine: record.future === undefined ? -1 : positionOf(record.future),
			})
		}
		const map = (source: Map<number, number[]>) => {
			const positions = new Map<number, number[]>()
			for (const [wire, ids] of source) {
				if (ids.length) positions.set(wire, ids.map(positionOf))
			}
			return positions
		}
		return this.cached = { nodes, dependantMap, access: { accesses: map(this.accesses), writes: map(this.writes) } }
	}
}
