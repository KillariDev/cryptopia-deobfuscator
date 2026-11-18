import { FactoredGraph, FactoredLimit, FactoredOptions, Form } from './factored.js'
import { Gate } from './types.js'
import { getVars, simplifyGate } from './utils.js'

/** Factor a triangular region as an independent driver, a linear accumulator,
 * and XOR updates in the accumulator's entry coordinates. */
export function simplifyMixedBasis(input: Gate[], options: FactoredOptions): Gate[] | undefined {
	const removed = new Set<number>()
	const partial = () => removed.size && !options.stopped() ? input.filter((_, i) => !removed.has(i)) : undefined
	try {
		const gates = input.map(gate => { if (options.stopped()) throw new FactoredLimit('canceled'); return simplifyGate(gate) })
		const reads = gates.map(gate => getVars(gate).slice(1))
		const wires = [...new Set(gates.flatMap((gate, i) => [gate.target, ...reads[i]]))].sort((a, b) => a - b)
		if (wires.length > options.maximumWires) return undefined
		const indices = new Map(wires.map((wire, i) => [wire, i]))
		const predecessors = wires.map(() => new Set<number>())
		const drivers = new Set<number>()
		for (let i = 0; i < gates.length; i++) {
			if (options.stopped()) return undefined
			const gate = gates[i]
			for (const wire of reads[i]) predecessors[indices.get(gate.target)!].add(wire)
			// The two-input nonlinear functions of distinct operands.
			if ([1, 2, 4, 7, 8, 11, 13, 14].includes(gate.gate_i)) {
				for (const wire of reads[i]) drivers.add(wire)
			}
		}
		for (const wire of drivers) for (const parent of predecessors[indices.get(wire)!]) drivers.add(parent)
		if (!drivers.size || drivers.size === wires.length) return undefined
		const graph = new FactoredGraph(wires, options)
		const rows = graph.inputs.slice()
		const bits = wires.map((_, i) => 1n << BigInt(i))
		const inverse = bits.slice(), driverGates: Gate[] = []
		const pureUpdates = new Map<string, { line: number, column: bigint, value: Form }>()
		for (let i = 0; i < gates.length; i++) {
			graph.check()
			const gate = gates[i], target = indices.get(gate.target)!
			if (drivers.has(gate.target)) {
				graph.update(gate, rows)
				driverGates.push(input[i])
				continue
			}
			const linear = reads[i].filter(wire => !drivers.has(wire))
			if (linear.length) {
				// XORing accumulator controls into the target right-multiplies
				// the inverse. Each control column gains the target column.
				if (linear.includes(gate.target) || linear.length !== reads[i].length || ![3, 5, 6].includes(gate.gate_i)) return partial()
				for (const wire of linear) inverse[indices.get(wire)!] ^= inverse[target]
				continue
			}
			const value = graph.update(gate, rows, graph.zero)
			rows[target] = graph.inputs[target]
			if (value === graph.zero) { removed.add(i); continue }
			const column = inverse[target]
			const key = `${column}:${value.id}`
			const prior = pureUpdates.get(key)
			if (prior) { removed.add(prior.line); removed.add(i); pureUpdates.delete(key) }
			else pureUpdates.set(key, { line: i, column, value })
		}

		// Retain the original basis changes if a high-degree update prevents
		// emission. The paired updates cancel independently of the final basis.
		if (inverse.some((column, i) => column !== bits[i])) return partial()
		const updates = graph.inputs.slice()
		for (const { column, value } of pureUpdates.values()) {
			graph.check()
			for (let i = 0; i < bits.length; i++) if (column & bits[i]) updates[i] = graph.xor(updates[i], value)
		}
		const tail = rows.every((row, i) => row === graph.inputs[i]) ? [] : driverGates
		const emitted = graph.emit(updates, input.length - removed.size - tail.length)
		return emitted && emitted.length + tail.length < input.length - removed.size ? [...emitted, ...tail] : partial()
	} catch (error) {
		if (error instanceof FactoredLimit) return partial()
		throw error
	}
}
