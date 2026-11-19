import { Gate } from './types.js'
import { evalGate, getVars, mapCircuit, reverseMapCircuit } from './utils.js'

const maximumNodes = 250_000
const maximumOperations = 1_000_000
const maximumDiagramWires = 64

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

	constructor(private readonly stopped: () => boolean) {}

	get nodeCount() { return this.nodes.length }

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
		if (++this.operations > maximumOperations || ((this.operations & 255) === 0 && this.stopped())) throw new DiagramLimit()
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

	evaluate(gates: readonly Gate[], initial: readonly number[]): number[] {
		const rows = initial.slice()
		for (const { a, b, target, gate_i } of gates) {
			const update = this.apply(gate_i, rows[a], rows[b])
			rows[target] = this.apply(6, rows[target], update)
		}
		return rows
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

/** Recover and prove a single positive product update by exact composition. */
export function synthesizeDecisionDiagramProduct(gates: Gate[], maximumWires: number, stopped: () => boolean) {
	if (gates.length < 2 || stopped()) return undefined
	const active = new Set<number>()
	for (let i = 0; i < gates.length; i++) {
		if ((i & 255) === 0 && stopped()) return undefined
		for (const wire of getVars(gates[i])) active.add(wire)
		if (active.size > Math.min(maximumWires, maximumDiagramWires)) return undefined
	}
	const wires = [...active].sort((a, b) => a - b)
	const diagram = new DecisionDiagram(stopped)
	try {
		const initial = wires.map((_, wire) => diagram.node(wire, 0, 1))
		const rows = diagram.evaluate(mapCircuit(gates, wires), initial)
		const changed = rows.flatMap((row, wire) => row === initial[wire] ? [] : [wire])
		if (changed.length !== 1) return undefined
		const [output] = changed
		const factors = diagram.positiveProduct(diagram.apply(6, rows[output], initial[output]))
		if (!factors || factors.length < 2 || factors.includes(output)) return undefined
		const borrowed = initial.flatMap((_, wire) => wire === output || factors.includes(wire) ? [] : [wire])
		if (borrowed.length < factors.length - 2) return undefined
		const replacement = emitBorrowedProduct(factors, borrowed, output)
		if (replacement.length >= gates.length) return undefined
		const actual = diagram.evaluate(replacement, initial)
		if (stopped()) return undefined
		if (!rows.every((row, wire) => row === actual[wire])) throw new Error('Decision diagram synthesis failed exact equivalence verification')
		return { gates: reverseMapCircuit(replacement, wires), diagramNodes: diagram.nodeCount, output: wires[output], factors: factors.map(wire => wires[wire]) }
	} catch (error) {
		if (error instanceof DiagramLimit) return undefined
		throw error
	}
}
