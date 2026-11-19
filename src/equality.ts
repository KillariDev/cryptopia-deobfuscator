import { Gate } from './types.js'
import { circuitState, applyState, stateKey, functionKey } from './semantic.js'
import { hashGates, isReplacementSimpler } from './utils.js'

/** Prefix nodes are interned by (parent equivalence class, gate). Classes use exact semantics. */
export class CircuitEqualityGraph {
	readonly classes = new Map<string, Set<string>>()
	add(gates: Gate[], wires: number) {
		let state = circuitState([], wires), parent = stateKey(state)
		for (const gate of gates) {
			state = applyState(state, gate)
			const key = stateKey(state)
			const members = this.classes.get(key) ?? new Set<string>()
			members.add(`${parent}|${hashGates([gate])}`)
			this.classes.set(key, members)
			parent = key
		}
		return parent
	}
}
export function saturateCircuit(original: Gate[], wires: number, nodes: number, timeoutMs: number, shouldStop: () => boolean = () => false) {
	if (shouldStop()) return undefined
	const graph = new CircuitEqualityGraph()
	const target = graph.add(original, wires)
	const seen = new Set<string>([hashGates(original)])
	const queue = [original]
	let best = original
	const end = performance.now() + timeoutMs
	for (let head = 0; head < queue.length && performance.now() < end && !shouldStop() && seen.size < nodes; head++) {
		const current = queue[head]
		const alternatives: Gate[][] = []
		let state = circuitState([], wires)
		const prefixes = new Map([[stateKey(state), 0]])
		for (let i = 0; i < current.length; i++) {
			if (shouldStop() || performance.now() >= end) break
			state = applyState(state, current[i])
			const key = stateKey(state), previous = prefixes.get(key)
			if (previous === undefined) prefixes.set(key, i + 1)
			else alternatives.push([...current.slice(0, previous), ...current.slice(i + 1)])
		}
		for (let i = 0; i < current.length - 1; i++) {
			if (shouldStop() || performance.now() >= end) break
			const pair = current.slice(i, i + 2)
			if (functionKey(pair, wires) !== functionKey(pair.slice().reverse(), wires)) continue
			alternatives.push([...current.slice(0, i), ...pair.reverse(), ...current.slice(i + 2)])
		}
		for (const candidate of alternatives) {
			if (performance.now() >= end || shouldStop() || seen.size >= nodes) break
			const key = hashGates(candidate)
			if (seen.has(key)) continue
			seen.add(key)
			if (graph.add(candidate, wires) !== target) throw new Error('Equality rewrite changed circuit semantics')
			queue.push(candidate)
			if (isReplacementSimpler(candidate, best)) best = candidate
		}
	}
	return isReplacementSimpler(best, original) ? best : undefined
}
