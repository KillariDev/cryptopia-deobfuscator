import { randomFillSync } from 'node:crypto'
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

/** Infer a shear from packed examples, then prove the replacement on all inputs. */
export function synthesizeQuadraticShear(gates: Gate[], maximumWires: number, maximumTerms: number, maximumOperations: number, stopped: () => boolean): Gate[] | undefined {
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

	const candidate: Gate[] = []
	if (targets.length) {
		const pairs: [number, number][] = []
		for (let a = 0; a < controls.length; a++) {
			for (let b = a + 1; b < controls.length; b++) pairs.push([a, b])
		}
		const samples = 1 + controls.length + pairs.length
		const fitting = new Uint32Array(Math.ceil(samples / 32) * width)
		const setBit = (wire: number, sample: number) => {
			fitting[(sample >>> 5) * width + wire] |= 1 << (sample & 31)
		}
		controls.forEach((wire, i) => setBit(wire, i + 1))
		pairs.forEach(([a, b], i) => {
			const sample = 1 + controls.length + i
			setBit(controls[a], sample)
			setBit(controls[b], sample)
		})
		const outputs = evaluatePacked(mapped, fitting, width, stopped)
		if (!outputs) return undefined
		const bit = (wire: number, sample: number) => (outputs[(sample >>> 5) * width + wire] >>> (sample & 31)) & 1
		for (const target of targets) {
			if (stopped()) return undefined
			const constant = bit(target, 0)
			if (constant) candidate.push({ a: 0, b: 0, target, gate_i: 15 })
			const linear = controls.map((a, i) => {
				const coefficient = bit(target, i + 1) ^ constant
				if (coefficient) candidate.push({ a, b: 0, target, gate_i: 3 })
				return coefficient
			})
			pairs.forEach(([a, b], i) => {
				if (bit(target, 1 + controls.length + i) ^ constant ^ linear[a] ^ linear[b]) {
					candidate.push({ a: controls[a], b: controls[b], target, gate_i: 1 })
				}
			})
			if (candidate.length >= gates.length) return undefined
		}
	}

	const predicted = evaluatePacked(candidate, probes, width, stopped)
	if (!predicted || predicted.some((value, i) => value !== observed[i]) || stopped()) return undefined
	const equivalent = createPolynomialEquivalenceChecker(mapped, width, maximumTerms, maximumOperations, stopped)
	return equivalent(candidate) === true && !stopped() ? reverseMapCircuit(candidate, wires) : undefined
}
