import { Gate, DependencyNode } from './types.js'
import { getVars, dependencyGraphToMap, DependencyContext } from './utils.js'
import { patchCircuit } from './circuit-edit.js'

type Record = { gate: Gate, wires: number[], past: Set<number>, future?: number }
/** Edges use stable gate IDs. Only users of edited wires need edge recomputation. */
export class IncrementalGraph {
	private next = 0
	private order: number[] = []
	private records = new Map<number, Record>()
	private positions = new Map<number, number>()
	private accesses = new Map<number, number[]>()
	private writes = new Map<number, number[]>()
	private cached?: DependencyContext
	constructor(gates: Gate[]) {
		for (const gate of gates) this.order.push(this.add(gate))
		this.reindex()
		this.updateWires(new Set(gates.flatMap(getVars)))
		this.recompute(new Set(this.order))
	}
	private add(gate: Gate) { const id = this.next++; this.records.set(id, { gate, wires: [...new Set(getVars(gate))], past: new Set() }); return id }
	private reindex() { this.positions = new Map(this.order.map((id, index) => [id, index])); this.cached = undefined }
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
		while (low < high) { const mid = (low + high) >>> 1; if (this.positions.get(list[mid])! < position + Number(future)) low = mid + 1; else high = mid }
		return future ? list[low] : list[low - 1]
	}
	private recompute(ids: Set<number>) {
		for (const id of ids) {
			const record = this.records.get(id)
			if (!record) continue
			const [target, ...controls] = getVars(record.gate), position = this.positions.get(id)!
			const past = [this.neighbor(this.accesses.get(target), position, false), ...controls.map(wire => this.neighbor(this.writes.get(wire), position, false))]
			record.past = new Set(past.filter((value): value is number => value !== undefined))
			const future = [this.neighbor(this.accesses.get(target), position, true), ...controls.map(wire => this.neighbor(this.writes.get(wire), position, true))].filter((value): value is number => value !== undefined)
			record.future = future.sort((a, b) => this.positions.get(a)! - this.positions.get(b)!)[0]
		}
	}
	replace(selected: number[], replacement: Gate[]) {
		const oldIds = selected.map(index => this.order[index])
		const touched = new Set([...oldIds.flatMap(id => this.records.get(id)!.wires), ...replacement.flatMap(getVars)])
		const newIds = replacement.map(gate => this.add(gate))
		this.order = patchCircuit(this.order, selected, newIds).values
		for (const id of oldIds) this.records.delete(id)
		this.reindex()
		const removed = new Set(oldIds)
		for (const wire of touched) {
			const merge = (source: Map<number, number[]>, writes: boolean) => {
				const existing = (source.get(wire) ?? []).filter(id => !removed.has(id))
				const incoming = newIds.filter(id => writes ? this.records.get(id)!.gate.target === wire : this.records.get(id)!.wires.includes(wire))
				if (!incoming.length) { source.set(wire, existing); return }
				const position = this.positions.get(incoming[0])!
				let low = 0, high = existing.length
				while (low < high) { const mid = (low + high) >>> 1; if (this.positions.get(existing[mid])! < position) low = mid + 1; else high = mid }
				source.set(wire, [...existing.slice(0, low), ...incoming, ...existing.slice(low)])
			}
			merge(this.accesses, false); merge(this.writes, true)
		}
		const affected = new Set([...touched].flatMap(wire => this.accesses.get(wire) ?? []))
		this.recompute(affected)
	}
	context(): DependencyContext {
		if (this.cached) return this.cached
		const nodes: DependencyNode[] = this.order.map((id, lineNumber) => {
			const record = this.records.get(id)!
			return { lineNumber, dependOnPastLines: [...record.past].map(id => this.positions.get(id)!).sort((a, b) => a - b), dependOnFutureLine: record.future === undefined ? -1 : this.positions.get(record.future)! }
		})
		const map = (source: Map<number, number[]>) => new Map([...source].filter(([, ids]) => ids.length > 0).map(([wire, ids]) => [wire, ids.map(id => this.positions.get(id)!)]))
		return this.cached = { nodes, dependantMap: dependencyGraphToMap(nodes), access: { accesses: map(this.accesses), writes: map(this.writes) } }
	}
}
