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
		this.updateWires(new Set(gates.flatMap(getVars)))
		this.recompute(new Set(this.order))
	}
	private add(gate: Gate) { const id = this.next++; this.records.set(id, { gate, wires: [...new Set(getVars(gate))], past: new Set() }); return id }
	private updateWires(wires: Set<number>) {
		for (const wire of wires) { this.accesses.set(wire, []); this.writes.set(wire, []) }
		for (const id of this.order) {
			const record = this.records.get(id)!
			for (const wire of record.wires) if (wires.has(wire)) this.accesses.get(wire)!.push(id)
			if (wires.has(record.gate.target)) this.writes.get(record.gate.target)!.push(id)
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
			const [target, ...controls] = getVars(record.gate), position = this.order.indexOf(id)!
			const past = [this.neighbor(this.accesses.get(target), position, false), ...controls.map(wire => this.neighbor(this.writes.get(wire), position, false))]
			record.past = new Set(past.filter((value): value is number => value !== undefined))
			const future = [this.neighbor(this.accesses.get(target), position, true), ...controls.map(wire => this.neighbor(this.writes.get(wire), position, true))].filter((value): value is number => value !== undefined)
			record.future = future.sort((a, b) => this.order.indexOf(a)! - this.order.indexOf(b)!)[0]
		}
	}
	/** Access-list edits change adjacent target users. Write edits additionally
	 * change control dependencies throughout the neighboring write interval. */
	private collectAffected(id: number, affected: Set<number>) {
		const record = this.records.get(id)!
		const position = this.order.indexOf(id)!
		for (const wire of record.wires) {
			for (const future of [false, true]) {
				const next = this.neighbor(this.accesses.get(wire), position, future)
				if (next !== undefined) affected.add(next)
			}
			if (wire !== record.gate.target) continue
			const before = this.neighbor(this.writes.get(wire), position, false)
			const after = this.neighbor(this.writes.get(wire), position, true)
			const low = before === undefined ? -1 : this.order.indexOf(before)!
			const high = after === undefined ? this.order.length : this.order.indexOf(after)!
			const list = this.accesses.get(wire) ?? []
			let start = 0, end = list.length
			while (start < end) { const mid = (start + end) >>> 1; if (this.order.indexOf(list[mid])! < low) start = mid + 1; else end = mid }
			for (let i = start; i < list.length && this.order.indexOf(list[i])! <= high; i++) affected.add(list[i])
		}
	}

	replace(selected: number[], replacement: Gate[]) {
		const oldIds = selected.map(index => this.order.at(index))
		const touched = new Set([...oldIds.flatMap(id => this.records.get(id)!.wires), ...replacement.flatMap(getVars)])
		const affected = new Set<number>()
		for (const id of oldIds) this.collectAffected(id, affected)
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
		for (const id of newIds) { affected.add(id); this.collectAffected(id, affected) }
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
