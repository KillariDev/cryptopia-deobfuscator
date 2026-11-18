import { emitQuadraticMap } from './polynomial-synthesis.js'
import { Gate } from './types.js'
import { evalGate, getVars, simplifyGate } from './utils.js'
import { simplifyAffineRegions, synthesizeAffineMap } from './affine.js'

// Algebraic normal form f(a,b) = c XOR alpha*a XOR beta*b XOR gamma*a*b.
const coefficients = Array.from({ length: 16 }, (_, gate) => {
	const c = Number(evalGate(gate, false, false, false))
	const a = Number(evalGate(gate, true, false, false)) ^ c
	const b = Number(evalGate(gate, false, true, false)) ^ c
	const ab = Number(evalGate(gate, true, true, false)) ^ c ^ a ^ b
	return { c, a, b, ab }
})
const nonlinear = (gate: Gate) => coefficients[simplifyGate(gate).gate_i].ab !== 0

function composePolynomials(input: Gate[], wires: number[], maximumTerms: number, stopped: () => boolean, spend: () => boolean) {
	const indices = new Map(wires.map((wire, i) => [wire, i]))
	// A set is a polynomial over GF(2); 0 is the constant monomial.
	// Multiplication unions variable masks because Boolean x*x equals x.
	const rows = wires.map((_, i) => new Set([1n << BigInt(i)]))
	let terms = rows.length
	if (terms > maximumTerms) return undefined
	const toggle = (row: Set<bigint>, monomial: bigint) => row.has(monomial) ? row.delete(monomial) : row.add(monomial)
	for (let index = 0; index < input.length; index++) {
		if (stopped()) return undefined
		const gate = input[index], rule = coefficients[gate.gate_i]
		const target = indices.get(gate.target)!
		const result = new Set(rows[target])
		const oldSize = rows[target].size
		if (rule.c) toggle(result, 0n)
		for (const control of [rule.a ? gate.a : undefined, rule.b ? gate.b : undefined]) {
			if (control === undefined) continue
			for (const monomial of rows[indices.get(control)!]) {
				if (spend()) return undefined
				toggle(result, monomial)
				if (terms - oldSize + result.size > maximumTerms) return undefined
			}
		}
		if (rule.ab) {
			for (const left of rows[indices.get(gate.a)!]) for (const right of rows[indices.get(gate.b)!]) {
				if (spend()) return undefined
				toggle(result, left | right)
				if (terms - oldSize + result.size > maximumTerms) return undefined
			}
		}
		terms += result.size - oldSize
		if (terms > maximumTerms) return undefined
		rows[target] = result // Aliased controls must read the old target until here.
	}
	return rows
}

/** Exact Boolean-polynomial composition, including nonlinear intermediates.
 * Resource exhaustion declines the rewrite; it never guesses affine behavior. */
export function synthesizeMixedAffine(input: Gate[], maximumWires: number, maximumTerms: number, maximumOperations: number, deadline = Infinity, shouldStop: () => boolean = () => false, allowQuadratic = false): Gate[] | undefined {
	const stopped = () => performance.now() >= deadline || shouldStop()
	const used = new Set<number>()
	for (let i = 0; i < input.length; i++) {
		if (i % 256 === 0 && stopped()) return undefined
		for (const wire of getVars(input[i])) used.add(wire)
		if (used.size > maximumWires) return undefined
	}
	const wires = [...used].sort((a, b) => a - b)
	let operations = 0
	const spend = () => ++operations > maximumOperations || (operations % 256 === 0 && stopped())
	const rows = composePolynomials(input, wires, maximumTerms, stopped, spend)
	if (!rows) return undefined
	const constant = 1n << BigInt(wires.length)
	const affine: bigint[] = []
	let allAffine = true
	for (const row of rows) {
		let expression = 0n
		for (const monomial of row) {
			if (spend()) return undefined
			if (monomial !== 0n && (monomial & (monomial - 1n)) !== 0n) allAffine = false
			expression ^= monomial === 0n ? constant : monomial
		}
		affine.push(expression)
	}
	if (allAffine) {
		const result = synthesizeAffineMap(affine, wires, input.length, stopped)
		if (result) return result
	}
	if (!allowQuadratic || stopped()) return undefined
	const result = emitQuadraticMap(rows, wires, input.length, stopped)
	if (!result) return undefined
	const actual = composePolynomials(result, wires, maximumTerms, stopped, spend)
	if (!actual) return undefined
	if (actual.some((row, i) => row.size !== rows[i].size || [...row].some(term => !rows[i].has(term)))) throw new Error('Quadratic synthesis failed exact polynomial verification')
	return result
}

/** Exact sparse quadratic synthesis; no sampling and no guessed dependencies. */
export function synthesizePolynomial(input: Gate[], maximumWires: number, maximumTerms: number, maximumOperations: number, deadline = Infinity, shouldStop: () => boolean = () => false) {
	return synthesizeMixedAffine(input, maximumWires, maximumTerms, maximumOperations, deadline, shouldStop, true)
}

/** Try both literal affine runs and regions whose nonlinear terms cancel. */
export function searchAffineRegions(gates: Gate[], maximumWires: number, maximumTerms: number, maximumOperations: number, deadline: number, shouldStop: () => boolean = () => false, allowQuadratic = false): Gate[] {
	const linear = simplifyAffineRegions(gates, maximumWires, deadline, shouldStop)
	if (performance.now() >= deadline || shouldStop() || !linear.some(nonlinear)) return linear
	const whole = synthesizeMixedAffine(linear, maximumWires, maximumTerms, maximumOperations, deadline, shouldStop, allowQuadratic)
	if (whole) return whole
	// A mixed whole circuit may be nonlinear while smaller regions are affine.
	for (const size of [2, 4, 8, 16, 32, 64, 128, 256]) {
		if (size >= linear.length) break
		const last = linear.length - size, positions = Math.min(8, last + 1)
		for (let slot = 0; slot < positions; slot++) {
			if (performance.now() >= deadline || shouldStop()) return linear
			const start = positions === 1 ? 0 : Math.floor(slot * last / (positions - 1))
			const region = linear.slice(start, start + size)
			if (!region.some(nonlinear)) continue
			const result = synthesizeMixedAffine(region, maximumWires, maximumTerms, maximumOperations, deadline, shouldStop, allowQuadratic)
			if (result) return [...linear.slice(0, start), ...result, ...linear.slice(start + size)]
		}
	}
	return linear
}

export function searchPolynomialRegions(gates: Gate[], maximumWires: number, maximumTerms: number, maximumOperations: number, deadline: number, shouldStop: () => boolean = () => false) {
	return searchAffineRegions(gates, maximumWires, maximumTerms, maximumOperations, deadline, shouldStop, true)
}
