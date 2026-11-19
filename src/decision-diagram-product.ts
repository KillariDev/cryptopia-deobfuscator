import { Gate } from './types.js'
import { evalGate, getVars, mapCircuit, reverseMapCircuit } from './utils.js'

const maximumNodes = 250_000
const maximumOperations = 1_000_000
const maximumDiagramWires = 64
const probeGates = 256
const probeOperations = 16_000

export type DiagramOrdering = 'off' | 'adaptive' | 'upfront'

export function emitBorrowedProduct(factors: readonly number[], borrowed: readonly number[], output: number): Gate[] {
	const gate = (a: number, b: number, target: number): Gate => ({ a, b, target, gate_i: 1 })
	if (factors.length === 2) return [gate(factors[0], factors[1], output)]
	const ladder = [gate(factors[0], factors[1], borrowed[0])]
	for (let i = 1; i < factors.length - 2; i++) {
		ladder.push(gate(factors[i + 1], borrowed[i - 1], borrowed[i]))
	}
	const flip = gate(factors[factors.length - 1], borrowed[factors.length - 3], output)
	// Omitting the first rung leaves just the initial borrowed-wire
	// contribution. XOR the two computations to isolate the product.
	const partial = ladder.slice(1)
	return [...ladder, flip, ...ladder.slice().reverse(), ...partial, flip, ...partial.reverse()]
}

type Decision = { wire: number, low: number, high: number }
class DiagramLimit extends Error {}

/** Reduced ordered diagram with canonical integer IDs and two terminal nodes. */
class DecisionDiagram {
	private readonly nodes: (Decision | undefined)[] = [undefined, undefined]
	private readonly unique = new Map<string, number>()
	private readonly memo = new Map<string, number>()
	private operations = 0

	constructor(private readonly stopped: () => boolean, public operationLimit = maximumOperations) {}

	get nodeCount() { return this.nodes.length }
	get operationCount() { return this.operations }

	node(wire: number, low: number, high: number): number {
		if (low === high) return low
		const key = `${wire},${low},${high}`
		const existing = this.unique.get(key)
		if (existing !== undefined) return existing
		if (this.nodes.length >= maximumNodes) throw new DiagramLimit()
		const id = this.nodes.push({ wire, low, high }) - 1
		this.unique.set(key, id)
		return id
	}

	apply(operation: number, a: number, b: number): number {
		if (++this.operations > this.operationLimit || ((this.operations & 255) === 0 && this.stopped())) throw new DiagramLimit()
		if (a < 2 && b < 2) return Number(evalGate(operation, a === 1, b === 1, false))
		const key = `${operation},${a},${b}`
		const existing = this.memo.get(key)
		if (existing !== undefined) return existing
		const left = this.nodes[a]
		const right = this.nodes[b]
		const wire = Math.min(left?.wire ?? Infinity, right?.wire ?? Infinity)
		const low = this.apply(operation, left?.wire === wire ? left.low : a, right?.wire === wire ? right.low : b)
		const high = this.apply(operation, left?.wire === wire ? left.high : a, right?.wire === wire ? right.high : b)
		const id = this.node(wire, low, high)
		this.memo.set(key, id)
		return id
	}

	step(rows: number[], { a, b, target, gate_i }: Gate) {
		const update = this.apply(gate_i, rows[a], rows[b])
		rows[target] = this.apply(6, rows[target], update)
	}

	liveNodes(rows: readonly number[]) {
		const visited = new Set<number>()
		const pending = rows.slice()
		while (pending.length) {
			const id = pending.pop()!
			const node = this.nodes[id]
			if (!node || visited.has(id)) continue
			if ((visited.size & 255) === 0 && this.stopped()) throw new DiagramLimit()
			visited.add(id)
			pending.push(node.low, node.high)
		}
		return visited.size
	}

	positiveProduct(id: number): number[] | undefined {
		const factors: number[] = []
		while (id > 1) {
			const { wire, low, high } = this.nodes[id]!
			if (low !== 0) return undefined
			factors.push(wire)
			id = high
		}
		return id === 1 ? factors : undefined
	}
}

function begin(order: number[], stopped: () => boolean, operationLimit = maximumOperations) {
	const diagram = new DecisionDiagram(stopped, operationLimit)
	const initial = order.map((_, wire) => diagram.node(wire, 0, 1))
	return { diagram, initial, rows: initial.slice(), order, completed: 0 }
}

type Evaluation = ReturnType<typeof begin>

function advance(state: Evaluation, mapped: Gate[], start: number, end = mapped.length) {
	for (let i = start; i < end; i++) {
		state.diagram.step(state.rows, mapped[i])
		state.completed++
	}
}

function synthesizeInOrder(gates: Gate[], state: Evaluation, stopped: () => boolean, adaptive = false) {
	const { diagram, initial, rows, order: wires } = state
	const reusedPrefixGates = state.completed
	const mapped = mapCircuit(state.completed ? gates.slice(state.completed) : gates, wires)
	if (adaptive) {
		for (let start = 0; start < mapped.length; start += 32) {
			const end = Math.min(start + 32, mapped.length)
			// Give an order more room as it approaches the end. A fixed
			// soft limit would retry regions that are almost complete.
			const progress = (end / mapped.length) ** 3
			diagram.operationLimit = Math.min(
				end <= probeGates ? 80_000 : maximumOperations,
				diagram.operationCount + 64_000,
				Math.floor(180_000 + (maximumOperations - 180_000) * progress),
			)
			advance(state, mapped, start, end)
			if (diagram.nodeCount > maximumNodes * (0.32 + 0.68 * progress)) throw new DiagramLimit()
		}
		diagram.operationLimit = maximumOperations
	} else {
		advance(state, mapped, 0)
	}
	const changed = rows.flatMap((row, wire) => row === initial[wire] ? [] : [wire])
	if (changed.length !== 1) return undefined
	const [output] = changed
	const factors = diagram.positiveProduct(diagram.apply(6, rows[output], initial[output]))
	if (!factors || factors.length < 2 || factors.includes(output)) return undefined
	const borrowed = initial.flatMap((_, wire) => wire === output || factors.includes(wire) ? [] : [wire])
	if (borrowed.length < factors.length - 2) return undefined
	const replacement = emitBorrowedProduct(factors, borrowed, output)
	if (replacement.length >= gates.length) return undefined
	const actual = initial.slice()
	for (const gate of replacement) diagram.step(actual, gate)
	if (stopped()) return undefined
	if (!rows.every((row, wire) => row === actual[wire])) throw new Error('Decision diagram synthesis failed exact equivalence verification')
	return {
		gates: reverseMapCircuit(replacement, wires), diagramNodes: diagram.nodeCount, liveNodes: diagram.liveNodes(rows),
		output: wires[output], factors: factors.map(wire => wires[wire]), reusedPrefixGates,
	}
}

// Grow a path through the strongest gate interactions. First use breaks
// ties, so the neighborhood order is independent of numeric wire labels.
function neighborhoodOrder(wires: number[], interactions: Map<number, Map<number, number>>) {
	const remaining = new Set(wires)
	const ordered: number[] = []
	while (remaining.size) {
		const weights = interactions.get(ordered[ordered.length - 1])
		let selected = remaining.values().next().value!
		for (const wire of remaining) {
			if ((weights?.get(wire) ?? 0) > (weights?.get(selected) ?? 0)) selected = wire
		}
		remaining.delete(selected)
		ordered.push(selected)
	}
	return ordered
}

function probe(gates: Gate[], order: number[], stopped: () => boolean) {
	const state = begin(order, stopped, probeOperations)
	const mapped = mapCircuit(gates, order)
	let live = 0
	try {
		for (const checkpoint of [32, 96, probeGates]) {
			advance(state, mapped, state.completed, Math.min(checkpoint, mapped.length))
			live = Math.max(live, state.diagram.liveNodes(state.rows))
			if (state.completed === mapped.length) break
		}
	} catch (error) {
		if (!(error instanceof DiagramLimit)) throw error
	}
	return { state, live }
}

function collectInteractions(gates: Gate[], stopped: () => boolean) {
	const interactions = new Map<number, Map<number, number>>()
	for (let i = 0; i < gates.length; i++) {
		if ((i & 255) === 0 && stopped()) break
		const distinct = new Set(getVars(gates[i]))
		for (const wire of distinct) {
			let neighbors = interactions.get(wire)
			if (!neighbors) { neighbors = new Map(); interactions.set(wire, neighbors) }
			for (const neighbor of distinct) {
				if (neighbor !== wire) neighbors.set(neighbor, (neighbors.get(neighbor) ?? 0) + 1)
			}
		}
	}
	return interactions
}

type TrialScore = { order: number[], completed: number, nodes: number, operations: number, live: number }

function compareTrials(a: TrialScore, b: TrialScore) {
	return b.completed - a.completed || a.live - b.live || a.nodes - b.nodes || a.operations - b.operations
}

function rankOrders(gates: Gate[], orders: number[][], stopped: () => boolean) {
	const first = gates.slice(0, probeGates)
	const laterStart = Math.max(0, Math.floor(gates.length / 2) - 32)
	const later = gates.slice(laterStart, laterStart + probeGates)
	const scores: TrialScore[] = []
	let best: TrialScore | undefined
	let prefix: Evaluation | undefined
	for (const order of orders) {
		if (stopped()) break
		const lead = probe(first, order, stopped)
		// The later window is a ranking probe. Only the real prefix can be resumed.
		const tail = laterStart && !stopped() ? probe(later, order, stopped) : undefined
		const score = {
			order, completed: lead.state.completed + (tail?.state.completed ?? 0),
			nodes: lead.state.diagram.nodeCount + (tail?.state.diagram.nodeCount ?? 0),
			operations: lead.state.diagram.operationCount + (tail?.state.diagram.operationCount ?? 0),
			live: lead.live + (tail?.live ?? 0),
		}
		scores.push(score)
		if (!best || compareTrials(score, best) < 0) {
			best = score
			prefix = lead.state
		}
	}
	return { orders: scores.sort(compareTrials).map(score => score.order), prefix, trials: scores.length }
}

/** Recover and prove a single positive product update by exact composition. */
export function synthesizeDecisionDiagramProduct(gates: Gate[], maximumWires: number, stopped: () => boolean, ordering: DiagramOrdering = 'adaptive') {
	if (gates.length < 2 || stopped()) return undefined
	const active = new Set<number>()
	const written = new Set<number>()
	for (let i = 0; i < gates.length; i++) {
		if ((i & 255) === 0 && stopped()) return undefined
		for (const wire of getVars(gates[i])) active.add(wire)
		written.add(gates[i].target)
		if (active.size > Math.min(maximumWires, maximumDiagramWires)) return undefined
	}

	// Read-only controls often decide whether a temporary write matters.
	// First use breaks ties independently of numeric wire labels.
	const firstUse = [...active]
	const primary = [...firstUse.filter(wire => !written.has(wire)), ...firstUse.filter(wire => written.has(wire))]
	const numeric = firstUse.slice().sort((a, b) => a - b)

	let initialAttempt: Evaluation | undefined
	if (ordering !== 'upfront') {
		initialAttempt = begin(primary, stopped)
		try {
			const result = synthesizeInOrder(gates, initialAttempt, stopped, ordering === 'adaptive')
			return result && { ...result, orderingTrials: 0 }
		} catch (error) {
			if (!(error instanceof DiagramLimit)) throw error
		}
	}

	if (stopped()) return undefined
	let ranked: ReturnType<typeof rankOrders> = { orders: [numeric], prefix: undefined, trials: 0 }
	if (ordering === 'off') {
		if (numeric.every((wire, i) => wire === primary[i])) return undefined
	} else {
		const orders = [primary, numeric, neighborhoodOrder(firstUse, collectInteractions(gates, stopped)), firstUse]
		const unique = new Map(orders.map(order => [order.join(','), order]))
		ranked = rankOrders(gates, [...unique.values()], stopped)
	}

	// A completed analysis is conclusive in any order. Keep at most two
	// full attempts after probing, with the same worker deadline.
	const finalists = ranked.orders.slice(0, 2)
	if (initialAttempt && !finalists.includes(initialAttempt.order)) initialAttempt = undefined
	for (const order of finalists) {
		if (stopped()) return undefined
		const prefix = ranked.prefix?.order === order ? ranked.prefix : undefined
		const canResumeInitial = initialAttempt?.order === order &&
			initialAttempt.completed >= (prefix?.completed ?? 0) &&
			initialAttempt.diagram.operationCount < maximumOperations && initialAttempt.diagram.nodeCount < maximumNodes
		const state = (canResumeInitial ? initialAttempt : prefix) ?? begin(order, stopped)
		state.diagram.operationLimit = maximumOperations
		try {
			const result = synthesizeInOrder(gates, state, stopped)
			return result && { ...result, orderingTrials: ranked.trials }
		} catch (error) {
			if (!(error instanceof DiagramLimit)) throw error
		}
	}
	return undefined
}
