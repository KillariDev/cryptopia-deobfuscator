import { randomFillSync } from 'node:crypto'
import { emitQuadraticMap } from './polynomial-synthesis.js'
import { packedControl } from './packed.js'
import { createPolynomialEquivalenceChecker } from './symbolic-affine.js'
import { Gate } from './types.js'
import { getVars, mapCircuit, reverseMapCircuit } from './utils.js'

function evaluatePacked(gates: Gate[], inputs: Uint32Array, wires: number, stopped: () => boolean) {
	const state = inputs.slice()
	for (let i = 0; i < gates.length; i++) {
		if ((i & 255) === 0 && stopped()) return undefined
		const { a, b, target, gate_i } = gates[i]
		for (let offset = 0; offset < state.length; offset += wires) {
			state[offset + target] ^= packedControl(gate_i, state[offset + a], state[offset + b])
		}
	}
	return state
}

function setInputBit(inputs: Uint32Array, width: number, wire: number, sample: number) {
	inputs[(sample >>> 5) * width + wire] |= 1 << (sample & 31)
}

function emitShear(rows: Set<bigint>[], wires: number[], targets: number[], maximumGates: number, stopped: () => boolean) {
	const best = emitQuadraticMap(rows, wires, maximumGates, stopped)
	let bestPair: { source: number, target: number } | undefined
	let saving = 2
	for (const source of targets) for (const target of targets) {
		if (stopped()) return undefined
		if (source === target) continue
		let overlap = 0
		for (const term of rows[source]) {
			if (rows[target].has(term)) overlap++
		}
		const gain = 2 * overlap - (rows[source].size - 1)
		if (gain > saving) { saving = gain; bestPair = { source, target } }
	}
	if (!bestPair) return best

	// Conjugate by a CNOT on the targets. The control wires stay fixed, so
	// the middle circuit can emit the symmetric difference of two deltas.
	const { source, target } = bestPair
	const modified = rows.slice()
	const delta = new Set(rows[target])
	for (const term of rows[source]) {
		if (term === 1n << BigInt(source)) continue
		if (!delta.delete(term)) delta.add(term)
	}
	modified[target] = delta
	const middle = emitQuadraticMap(modified, wires, (best?.length ?? maximumGates) - 2, stopped)
	if (!middle) return best
	const basisGate = { a: source, b: 0, target, gate_i: 3 }
	return [basisGate, ...middle, basisGate]
}

function fitQuadratic(gates: Gate[], width: number, controls: number[], targets: number[], stopped: () => boolean) {
	const pairs: [number, number][] = []
	for (let a = 0; a < controls.length; a++) {
		for (let b = a + 1; b < controls.length; b++) pairs.push([a, b])
	}
	const samples = 1 + controls.length + pairs.length
	const fitting = new Uint32Array(Math.ceil(samples / 32) * width)
	controls.forEach((wire, i) => setInputBit(fitting, width, wire, i + 1))
	pairs.forEach(([a, b], i) => {
		const sample = 1 + controls.length + i
		setInputBit(fitting, width, controls[a], sample)
		setInputBit(fitting, width, controls[b], sample)
	})
	const outputs = evaluatePacked(gates, fitting, width, stopped)
	if (!outputs) return undefined
	const bits = Array.from({ length: width }, (_, i) => 1n << BigInt(i))
	const rows = bits.map(bit => new Set([bit]))
	for (const target of targets) {
		if (stopped()) return undefined
		const bit = (sample: number) => {
			const index = (sample >>> 5) * width + target
			return ((outputs[index] ^ fitting[index]) >>> (sample & 31)) & 1
		}
		const toggle = (term: bigint) => { if (!rows[target].delete(term)) rows[target].add(term) }
		const constant = bit(0)
		if (constant) toggle(0n)
		const linear = controls.map((wire, i) => {
			const coefficient = bit(i + 1) ^ constant
			if (coefficient) toggle(bits[wire])
			return coefficient
		})
		pairs.forEach(([a, b], i) => {
			if (bit(1 + controls.length + i) ^ constant ^ linear[a] ^ linear[b]) toggle(bits[controls[a]] | bits[controls[b]])
		})
	}
	const wires = bits.map((_, i) => i)
	return controls.length === width
		? emitQuadraticMap(rows, wires, gates.length, stopped)
		: emitShear(rows, wires, targets, gates.length, stopped)
}

export type QuadraticVerification = { verification: 'polynomial' | 'exhaustive' | 'sampled', validationInputs?: number }

function checkPacked(gates: Gate[], candidate: Gate[], inputs: Uint32Array, width: number, stopped: () => boolean) {
	const reference = evaluatePacked(gates, inputs, width, stopped)
	if (!reference) return false
	const replacement = evaluatePacked(candidate, inputs, width, stopped)
	return replacement !== undefined && replacement.every((value, i) => value === reference[i]) && !stopped()
}

export function quadraticShearSampleCount(gates: number, wires: number, minimum: number) {
	if (minimum <= 0) return 0
	const complexity = Math.max(Math.ceil(wires / 16), Math.ceil(Math.log2(1 + gates / 1024)))
	return Math.max(minimum, 4096 * Math.min(16, Math.max(1, complexity)))
}

/** Infer a quadratic map and verify the emitted circuit independently of fitting. */
export function synthesizeQuadraticShear(gates: Gate[], maximumWires: number, maximumTerms: number, maximumOperations: number, stopped: () => boolean, fallbackSamples = 0, onVerified?: (result: QuadraticVerification) => void): Gate[] | undefined {
	const active = new Set<number>()
	for (let i = 0; i < gates.length; i++) {
		if ((i & 255) === 0 && stopped()) return undefined
		for (const wire of getVars(gates[i])) active.add(wire)
		if (active.size > Math.min(maximumWires, 64)) return undefined
	}
	const wires = [...active].sort((a, b) => a - b)
	const width = wires.length
	if (!width) return undefined
	const mapped = mapCircuit(gates, wires)

	// Use independent full-width samples to suggest the unchanged control wires
	// and to reject a fit that fails outside the interpolation inputs.
	const probes = randomFillSync(new Uint32Array(4 * width))
	const observed = evaluatePacked(mapped, probes, width, stopped)
	if (!observed) return undefined
	const controls: number[] = [], targets: number[] = []
	for (let wire = 0; wire < width; wire++) {
		let changed = false
		for (let offset = 0; offset < probes.length; offset += width) {
			changed ||= probes[offset + wire] !== observed[offset + wire]
		}
		if (changed) targets.push(wire)
		else controls.push(wire)
	}

	const candidates = function* () {
		yield targets.length ? fitQuadratic(mapped, width, controls, targets, stopped) : []
		if (targets.length && controls.length < width && !stopped()) {
			yield fitQuadratic(mapped, width, wires.map((_, i) => i), targets, stopped)
		}
	}
	const equivalent = createPolynomialEquivalenceChecker(mapped, width, maximumTerms, maximumOperations, stopped)
	for (const candidate of candidates()) {
		if (stopped()) return undefined
		if (!candidate || candidate.length >= gates.length) continue
		const predicted = evaluatePacked(candidate, probes, width, stopped)
		if (!predicted || predicted.some((value, i) => value !== observed[i])) continue
		if (width <= 12) {
			const count = 2 ** width
			const inputs = new Uint32Array(Math.ceil(count / 32) * width)
			for (let sample = 0; sample < count; sample++) {
				for (let wire = 0; wire < width; wire++) {
					if (sample & (1 << wire)) setInputBit(inputs, width, wire, sample)
				}
			}
			if (!checkPacked(mapped, candidate, inputs, width, stopped)) continue
			onVerified?.({ verification: 'exhaustive', validationInputs: count })
		} else {
			const proof = equivalent(candidate)
			if (stopped()) return undefined
			if (proof === false) continue
			if (proof === true) onVerified?.({ verification: 'polynomial' })
			else {
				const count = quadraticShearSampleCount(gates.length, width, fallbackSamples)
				if (!count) continue
				let checked = 0
				while (checked < count && !stopped()) {
					const batches = Math.ceil(Math.min(count - checked, 4096) / 32)
					const samples = randomFillSync(new Uint32Array(batches * width))
					if (!checkPacked(mapped, candidate, samples, width, stopped)) break
					checked += batches * 32
				}
				if (checked < count || stopped()) continue
				onVerified?.({ verification: 'sampled', validationInputs: checked })
			}
		}
		return reverseMapCircuit(candidate, wires)
	}
	return undefined
}

/** Sample possible restore boundaries to prioritize broad searches. */
export function* quadraticShearRegions(gates: Gate[], width: number, minimum: number) {
	// Keep cursor preparation bounded on large circuits.
	if (width < 2 || width > 64 || gates.length > 250_000) return
	const inputs = randomFillSync(new Uint32Array(width))
	const final = evaluatePacked(gates, inputs, width, () => false)!
	const stable = Array.from(inputs).flatMap((value, wire) => value === final[wire] ? [wire] : [])
	if (!stable.length || stable.length === width) return
	const state = inputs.slice(), retained = new Set(stable)
	let start = 0, changed = 0, sawDeparture = false, emitted = 0
	for (let i = 0; i < gates.length; i++) {
		const { a, b, target, gate_i } = gates[i]
		const before = state[target] !== inputs[target]
		state[target] ^= packedControl(gate_i, state[a], state[b])
		if (retained.has(target)) changed += Number(state[target] !== inputs[target]) - Number(before)
		if (changed) sawDeparture = true
		if (!changed && sawDeparture && i + 1 - start >= minimum) {
			if (start !== 0 || i + 1 !== gates.length) {
				yield { start, end: i + 1 }
				if (++emitted >= 16) return
			}
			start = i + 1
			sawDeparture = false
		}
	}
}
