import { Gate } from './types.js'
import { getVars, simplifyGate } from './utils.js'
import { analyzeFactored, FactoredLimit, FactoredOptions } from './factored.js'

function canonical(gate: Gate): Gate {
	const value = simplifyGate(gate)
	if (value.gate_i === 5) return { a: value.b, b: 0, target: value.target, gate_i: 3 }
	if (value.gate_i === 3) return { ...value, b: 0 }
	if (value.gate_i === 0 || value.gate_i === 15) return { ...value, a: 0, b: 0 }
	return value
}

/** Prove a block has the form (x,y) -> (x,y XOR h(x)). Dependencies are an
 * overapproximation, so inconclusive summaries merely miss an optimization. */
function shear(gates: Gate[], options: FactoredOptions) {
	const { graph, rows } = analyzeFactored(gates, options)
	let writes = 0n, controls = 0n
	for (let i = 0; i < rows.length; i++) {
		graph.check()
		if (rows[i] === graph.inputs[i]) continue
		writes |= 1n << BigInt(graph.wires[i])
		const delta = graph.xor(rows[i], graph.inputs[i])
		for (let j = 0; j < graph.wires.length; j++) if (delta.support & (1n << BigInt(j))) controls |= 1n << BigInt(graph.wires[j])
	}
	return writes & controls ? undefined : { writes, controls }
}

/** Discover repeated blocks from gate anchors, then use exact shear proofs to
 * cancel A M A when A and M commute and A is an involution. Hashes discover
 * candidates only; every repeated gate is compared before changing the circuit. */
export function cancelBlocks(input: Gate[], options: FactoredOptions): Gate[] | undefined {
	try {
		const gates: Gate[] = [], keys: string[] = []
		for (const raw of input) {
			if (options.stopped()) return undefined
			const gate = canonical(raw), key = JSON.stringify([gate.a, gate.b, gate.target, gate.gate_i])
			if (gate.gate_i === 0) continue
			const reads = getVars(gate).slice(1)
			let canceled = false
			if (!reads.includes(gate.target)) for (let i = gates.length - 1; i >= 0; i--) {
				if (options.stopped()) return undefined
				if (keys[i] === key) { gates.splice(i, 1); keys.splice(i, 1); canceled = true; break }
				if (reads.includes(gates[i].target) || getVars(gates[i]).slice(1).includes(gate.target)) break
			}
			if (!canceled) { gates.push(gate); keys.push(key) }
		}
		const n = gates.length, width = Math.min(8, Math.max(2, Math.floor(n / 8)))
		const prefix = new Uint32Array(n + 1), powers = new Uint32Array(n + 1)
		powers[0] = 1
		for (let i = 0; i < n; i++) {
			if (options.stopped()) return undefined
			let hash = 2166136261
			for (const character of keys[i]) hash = Math.imul(hash ^ character.charCodeAt(0), 16777619)
			prefix[i + 1] = Math.imul(prefix[i], 16777619) + hash
			powers[i + 1] = Math.imul(powers[i], 16777619)
		}
		const hash = (start: number, length: number) => (prefix[start + length] - Math.imul(prefix[start], powers[length])) >>> 0
		const anchors = new Map<number, number[]>()
		for (let right = 0; right + width <= n; right++) {
			if (options.stopped()) return undefined
			const anchor = hash(right, width), prior = anchors.get(anchor) ?? []
			for (const left of prior) {
				let low = 0, high = Math.min(right - left, n - right)
				if (high < width) continue
				while (low < high) { const mid = Math.ceil((low + high) / 2); if (hash(left, mid) === hash(right, mid)) low = mid; else high = mid - 1 }
				let length = 0
				while (length < low && keys[left + length] === keys[right + length]) { if (options.stopped()) return undefined; length++ }
				if (length < width) continue
				let a: ReturnType<typeof shear>, middle: ReturnType<typeof shear>
				try {
					a = shear(gates.slice(left, left + length), options)
					if (!a) continue
					middle = shear(gates.slice(left + length, right), options)
				} catch (error) { if (error instanceof FactoredLimit && !options.stopped()) continue; throw error }
				if (!middle || (a.writes & middle.controls) || (middle.writes & a.controls)) continue
				return [...gates.slice(0, left), ...gates.slice(left + length, right), ...gates.slice(right + length)]
			}
			// A bounded anchor history controls memory; correctness never relies on it.
			if (prior.length < 8) prior.push(right)
			anchors.set(anchor, prior)
		}
		return gates.length < input.length ? gates : undefined
	} catch (error) { if (error instanceof FactoredLimit) return undefined; throw error }
}
