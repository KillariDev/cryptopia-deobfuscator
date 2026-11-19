import { randomFillSync } from 'node:crypto'
import { emitPolynomialShear, emitQuadraticMap, borrowedProductGateCount } from './polynomial-synthesis.js'
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

function fittingInputCount(controls: number, degree: number) {
	let total = 1, terms = 1
	for (let size = 1; size <= Math.min(controls, degree); size++) {
		terms = terms * (controls - size + 1) / size
		total += terms
	}
	return total
}

function fitPolynomial(gates: Gate[], width: number, controls: number[], targets: number[], stopped: () => boolean, degree = 2) {
	const samples = fittingInputCount(controls.length, degree)
	const fitting = new Uint32Array(Math.ceil(samples / 32) * width)
	const bits = Array.from({ length: width }, (_, i) => 1n << BigInt(i))
	const masks: bigint[] = [0n]
	const indices = new Map([[0n, 0]])
	const transform: number[][] = controls.map(() => [])
	const chosen: number[] = []
	const enumerate = (next: number, remaining: number, mask: bigint) => {
		if (remaining) {
			for (let i = next; i <= controls.length - remaining; i++) {
				chosen.push(i)
				enumerate(i + 1, remaining - 1, mask | bits[controls[i]])
				chosen.pop()
			}
			return
		}
		const sample = masks.length
		masks.push(mask)
		indices.set(mask, sample)
		for (const i of chosen) {
			const wire = controls[i]
			setInputBit(fitting, width, wire, sample)
			transform[i].push(sample, indices.get(mask ^ bits[wire])!)
		}
	}
	for (let size = 1; size <= degree; size++) {
		if (stopped()) return undefined
		enumerate(0, size, 0n)
	}
	const outputs = evaluatePacked(gates, fitting, width, stopped)
	if (!outputs) return undefined
	const rows = bits.map(bit => new Set([bit]))
	for (const target of targets) {
		if (stopped()) return undefined
		const coefficients = new Uint8Array(samples)
		for (let sample = 0; sample < samples; sample++) {
			const index = (sample >>> 5) * width + target
			coefficients[sample] = ((outputs[index] ^ fitting[index]) >>> (sample & 31)) & 1
		}
		// Low-weight inputs are closed under removing a bit, so the Boolean
		// Möbius transform only visits the sampled inputs.
		for (const pairs of transform) {
			for (let i = 0; i < pairs.length; i += 2) coefficients[pairs[i]] ^= coefficients[pairs[i + 1]]
		}
		for (let sample = 0; sample < samples; sample++) {
			if (coefficients[sample] && !rows[target].delete(masks[sample])) rows[target].add(masks[sample])
		}
	}
	const wires = bits.map((_, i) => i)
	if (degree > 2) return emitPolynomialShear(rows, wires, gates.length, stopped)
	return controls.length === width
		? emitQuadraticMap(rows, wires, gates.length, stopped)
		: emitShear(rows, wires, targets, gates.length, stopped)
}

export type PolynomialShearVerification = { verification: 'polynomial' | 'exhaustive' | 'sampled', validationInputs?: number }

function checkPacked(gates: Gate[], candidate: Gate[], inputs: Uint32Array, width: number, stopped: () => boolean) {
	const reference = evaluatePacked(gates, inputs, width, stopped)
	if (!reference) return false
	const replacement = evaluatePacked(candidate, inputs, width, stopped)
	return replacement !== undefined && replacement.every((value, i) => value === reference[i]) && !stopped()
}

export function polynomialShearSampleCount(gates: number, wires: number, minimum: number) {
	if (minimum <= 0) return 0
	const complexity = Math.max(Math.ceil(wires / 16), Math.ceil(Math.log2(1 + gates / 1024)))
	return Math.max(minimum, 4096 * Math.min(16, Math.max(1, complexity)))
}

/** Infer a quadratic map or a higher-degree shear and verify the emitted circuit independently of fitting. */
export function synthesizePolynomialShear(gates: Gate[], maximumWires: number, maximumTerms: number, maximumOperations: number, stopped: () => boolean, fallbackSamples = 0, onVerified?: (result: PolynomialShearVerification) => void, maximumDegree = 8): Gate[] | undefined {
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
		yield targets.length ? fitPolynomial(mapped, width, controls, targets, stopped) : []
		if (targets.length && controls.length < width && !stopped()) {
			yield fitPolynomial(mapped, width, wires.map((_, i) => i), targets, stopped)
		}
		let remainingWork = 64_000_000
		for (let degree = 3; degree <= maximumDegree && 2 * degree - 2 <= controls.length && !stopped(); degree++) {
			if (degree === 5) {
				// High-degree terms can flip infrequently. Refine the partition
				// before expensive fits so rare targets aren't dropped early.
				const extra = randomFillSync(new Uint32Array(128 * width))
				const output = evaluatePacked(mapped, extra, width, stopped)
				if (!output) return
				for (let i = controls.length - 1; i >= 0; i--) {
					const wire = controls[i]
					for (let offset = 0; offset < extra.length; offset += width) {
						if (extra[offset + wire] === output[offset + wire]) continue
						controls.splice(i, 1)
						targets.push(wire)
						break
					}
				}
			}
			if (!targets.length) {
				if (degree >= 5) break
				continue
			}
			const samples = fittingInputCount(controls.length, degree)
			remainingWork -= gates.length * Math.ceil(samples / 32)
			if (2 * degree - 2 > controls.length || samples > 65_536 || remainingWork < 0 || borrowedProductGateCount(degree) >= gates.length) break
			yield fitPolynomial(mapped, width, controls, targets, stopped, degree)
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
				const count = polynomialShearSampleCount(gates.length, width, fallbackSamples)
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
export function* polynomialShearRegions(gates: Gate[], width: number, minimum: number) {
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
