import { Gate } from './types.js'
import { calculateAllOutputsArray, generateCombinations, getVars, isReplacementSimpler } from './utils.js'

export function truthKey(outputs: boolean[]) {
	const buffer = Buffer.alloc(Math.ceil(outputs.length / 8))
	outputs.forEach((value, i) => { if (value) buffer[i >>> 3] |= 1 << (i & 7) })
	return buffer
}
export const functionKey = (gates: Gate[], wires: number) => truthKey(calculateAllOutputsArray(gates, generateCombinations(wires))).toString('hex')
export const encodeGates = (gates: Gate[]) => Buffer.from(gates.flatMap(g => [g.a, g.b, (g.gate_i << 4) | g.target]))
export function decodeGates(value: Buffer): Gate[] {
	if (!Buffer.isBuffer(value)) throw new Error('Rainbow gate payload must be binary')
	const bytes = value
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

/** Bounded forward synthesis over all Boolean gates, including target/control overlap.
 * Full truth states merge equivalent prefixes. A collision of two inputs that the
 * target distinguishes can never be undone by any suffix, so prune it immediately.
 */
export function synthesizeNative(original: Gate[], wires: number, maxGates: number, limit: number, timeoutMs: number): Gate[] | undefined {
	if (!Number.isInteger(wires) || wires < 1 || wires > 4) throw new Error('Native synthesis supports 1-4 wires')
	const end = performance.now() + timeoutMs
	const target = circuitState(original, wires), identity = circuitState([], wires)
	const goal = stateKey(target)
	if (goal === stateKey(identity)) return original.length ? [] : undefined
	if (limit < 1 || maxGates < 1) return undefined
	// Deduplicate single-gate transformations, including unused/repeated controls.
	const catalog = new Map<string, Gate>()
	for (let target = 0; target < wires; target++) for (let a = 0; a < wires; a++) for (let b = 0; b < wires; b++) for (let gate_i = 1; gate_i < 16; gate_i++) {
		if (performance.now() >= end) return undefined
		const gate = { a, b, target, gate_i }, key = stateKey(applyState(identity, gate))
		const old = catalog.get(key)
		if (!old || isReplacementSimpler([gate], [old])) catalog.set(key, gate)
	}
	let frontier = [{ state: identity, gates: [] as Gate[] }]
	const seen = new Set([stateKey(identity)])
	for (let depth = 1; depth <= Math.min(maxGates, original.length - 1); depth++) {
		const next: typeof frontier = []
		for (const entry of frontier) for (const gate of catalog.values()) {
			if (performance.now() >= end) return undefined
			const state = applyState(entry.state, gate), key = stateKey(state)
			if (seen.has(key)) continue
			const candidate = [...entry.gates, gate]
			if (key === goal) return isReplacementSimpler(candidate, original) && functionKey(candidate, wires) === functionKey(original, wires) ? candidate : undefined
			if (depth === Math.min(maxGates, original.length - 1)) continue
			const outputs = new Map<number, number>()
			let compatible = true
			for (let i = 0; i < state.length; i++) {
				const prior = outputs.get(state[i])
				if (prior !== undefined && prior !== target[i]) { compatible = false; break }
				outputs.set(state[i], target[i])
			}
			if (!compatible) continue
			if (seen.size >= limit) return undefined
			seen.add(key)
			next.push({ state, gates: candidate })
		}
		frontier = next
		if (!frontier.length) break
	}
	return undefined
}
