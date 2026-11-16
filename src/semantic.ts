import * as generationProgressHelpers from './generation-progress.js'
import { Gate } from './types.js'
import { calculateAllOutputsArray, generateCombinations, getVars, isReplacementSimpler } from './utils.js'

export function truthKey(outputs: boolean[]) {
	const buffer = Buffer.alloc(Math.ceil(outputs.length / 8))
	outputs.forEach((value, i) => { if (value) buffer[i >>> 3] |= 1 << (i & 7) })
	return buffer
}
export const functionKey = (gates: Gate[], wires: number) => truthKey(calculateAllOutputsArray(gates, generateCombinations(wires))).toString('hex')
export const encodeGates = (gates: Gate[]) => Buffer.from(gates.flatMap(g => [g.a, g.b, (g.gate_i << 4) | g.target]))
export function decodeGates(value: string | Buffer): Gate[] {
	const bytes = typeof value === 'string' ? Buffer.from(value, 'latin1') : value
	if (bytes.length % 3) throw new Error('Invalid gate payload')
	return Array.from({ length: bytes.length / 3 }, (_, i) => ({ a: bytes[i * 3], b: bytes[i * 3 + 1], target: bytes[i * 3 + 2] & 15, gate_i: bytes[i * 3 + 2] >>> 4 }))
}
export function applyState(state: Uint8Array, gate: Gate) {
	return state.map(word => {
		const a = (word >>> gate.a) & 1, b = (word >>> gate.b) & 1
		return word ^ (((gate.gate_i >>> (3 - (a * 2 + b))) & 1) << gate.target)
	})
}
export const stateKey = (state: Uint8Array) => Buffer.from(state).toString('hex')
export function circuitState(gates: Gate[], wires: number) {
	if (!Number.isInteger(wires) || wires < 0 || wires > 8) throw new Error('Semantic states support at most eight wires')
	return gates.reduce(applyState, Uint8Array.from({ length: 2 ** wires }, (_, i) => i))
}

/** Breadth-first semantic search. Equal-depth states retain used-wire cost metadata. */
export function* semanticCircuits(wires: number, maxGates: number, catalog: Gate[], limit: number, onProgress?: (progress: import('./generation-progress.js').SemanticProgress) => void): Generator<Gate[]> {
	let frontier: { gates: Gate[], state: Uint8Array }[] = [{ gates: [], state: circuitState([], wires) }]
	const depths = new Map<string, number>()
	const costs = new Map<string, number>()
	let states = 0
	for (let depth = 0; depth <= maxGates && frontier.length; depth++) {
		const next: typeof frontier = []
		for (const [index, entry] of frontier.entries()) {
			if (index % 1024 === 0) onProgress?.({ depth, processed: index, total: frontier.length, states })
			const key = stateKey(entry.state)
			const prior = depths.get(key)
			if (prior !== undefined && prior < depth) continue
			const mask = [...new Set(entry.gates.flatMap(getVars))].reduce((mask, wire) => mask | (1 << wire), 0)
			const costKey = `${key}:${mask}`
			const reads = entry.gates.reduce((sum, gate) => sum + getVars(gate).length, 0)
			if (costs.has(costKey) && costs.get(costKey)! <= reads) continue
			if (++states > limit) throw new Error('Semantic generation state limit reached; increase database.generationStates to continue building')
			depths.set(key, depth)
			costs.set(costKey, reads)
			yield entry.gates
			if (depth < maxGates) for (const gate of catalog) {
				if (next.length >= limit) throw new Error('Semantic frontier limit reached; increase database.generationStates')
				next.push({ gates: [...entry.gates, gate], state: applyState(entry.state, gate) })
			}
		}
		onProgress?.({ depth, processed: frontier.length, total: frontier.length, states })
		frontier = next
	}
}

/** Meet-in-the-middle is valid only for bijective target functions. */
export function meetInMiddle(gates: Gate[], wires: number, catalog: Gate[], maxDepth: number, limit: number, timeoutMs: number) {
	catalog = catalog.filter(gate => !getVars(gate).slice(1).includes(gate.target))
	const target = circuitState(gates, wires)
	if (new Set(target).size !== target.length) return undefined
	const end = performance.now() + timeoutMs
	const identity = circuitState([], wires)
	if (stateKey(identity) === stateKey(target) && gates.length) return []
	const left = new Map<string, Gate[]>([[stateKey(identity), []]])
	let frontier = [{ state: identity, gates: [] as Gate[] }]
	for (let depth = 1; depth <= Math.ceil(maxDepth / 2); depth++) {
		const next: typeof frontier = []
		for (const entry of frontier) for (const gate of catalog) {
			if (performance.now() >= end || left.size >= limit) return undefined
			const state = applyState(entry.state, gate), key = stateKey(state)
			if (!left.has(key)) {
				const sequence = [...entry.gates, gate]
				if (key === stateKey(target) && isReplacementSimpler(sequence, gates)) return sequence
				left.set(key, sequence)
				next.push({ state, gates: sequence })
			}
		}
		frontier = next
	}
	frontier = [{ state: target, gates: [] }]
	for (let depth = 0; depth <= Math.floor(maxDepth / 2); depth++) {
		const next: typeof frontier = []
		for (const entry of frontier) {
			const prefix = left.get(stateKey(entry.state))
			if (prefix) {
				const candidate = [...prefix, ...entry.gates.slice().reverse()]
				if (candidate.length <= maxDepth && isReplacementSimpler(candidate, gates) && stateKey(circuitState(candidate, wires)) === stateKey(target)) return candidate
			}
			if (depth === Math.floor(maxDepth / 2)) continue
			for (const gate of catalog) {
				if (performance.now() >= end || next.length >= limit) return undefined
				next.push({ state: applyState(entry.state, gate), gates: [...entry.gates, gate] })
			}
		}
		frontier = next
	}
	return undefined
}

/** Invalid first-use numbering can never be repaired by appending more gates. */
export function* canonicalCircuits(catalog: Gate[], maximumDepth: number, onProgress?: (progress: import('./generation-progress.js').SequenceProgress) => void): Generator<Gate[]> {
	const { sequenceSpace } = generationProgressHelpers
	const sizes = sequenceSpace(catalog.length, maximumDepth)
	const total = sizes[maximumDepth]
	let covered = 0n, pruned = 0n, examined = 0, evaluated = 0
	const stack = [{ gates: [] as Gate[], depth: 0 }]
	while (stack.length) {
		const { gates, depth } = stack.pop()!
		examined++
		const wires = [...new Set(gates.flatMap(getVars))]
		if (!wires.every((wire, index) => wire === index)) {
			const skipped = sizes[maximumDepth - depth]
			covered += skipped
			pruned += skipped
		} else {
			covered++
			evaluated++
			yield gates
			if (depth < maximumDepth) for (const gate of catalog) stack.push({ gates: [...gates, gate], depth: depth + 1 })
		}
		if (examined % 1024 === 0) onProgress?.({ covered, total, examined, evaluated, pruned })
	}
	onProgress?.({ covered, total, examined, evaluated, pruned })
}
