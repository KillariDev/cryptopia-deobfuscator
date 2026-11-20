import assert from 'node:assert/strict'
import { synthesizeMixedAffine, searchAffineRegions, createPolynomialEquivalenceChecker } from './symbolic-affine.js'
import { evalCircuit, generateCombinations } from './utils.js'
import { seededRandom } from './random.js'
import { Gate } from './types.js'

const synthesize = (gates: Gate[]) => synthesizeMixedAffine(gates, 64, 100000, 10000000)
const equivalent = (before: Gate[], after: Gate[], wires: number) => {
	for (const input of generateCombinations(wires)) assert.deepEqual(evalCircuit(after, input), evalCircuit(before, input))
}
const not: Gate = { a: 0, b: 0, target: 0, gate_i: 15 }
const toffoli: Gate = { a: 0, b: 1, target: 2, gate_i: 1 }
assert.deepEqual(synthesize([toffoli, toffoli, not]), [not])
assert.equal(synthesize([toffoli, not, not]), undefined, 'do not mistake a genuinely nonlinear map for an affine map')
assert.equal(synthesizeMixedAffine([toffoli, toffoli, not], 64, 3, 100000), undefined, 'decline on intermediate term growth even if it would later cancel')
assert.equal(synthesizeMixedAffine([toffoli, toffoli, not], 64, 100000, 1), undefined)
assert.equal(synthesizeMixedAffine([toffoli, toffoli, not], 2, 100000, 100000), undefined)
assert.equal(synthesizeMixedAffine([toffoli, toffoli, not], 64, 100000, 100000, -Infinity), undefined)
assert.equal(synthesizeMixedAffine([toffoli, toffoli, not], 64, 100000, 100000, Infinity, () => true), undefined)
const other: Gate = { a: 0, b: 1, target: 3, gate_i: 1 }
const mixed = [toffoli, toffoli, other]
const partial = searchAffineRegions(mixed, 64, 100000, 10000000, Infinity)
assert.deepEqual(partial, [other], 'discover affine behavior inside a genuinely nonlinear surrounding circuit')
equivalent(mixed, partial, 4)
// Every Boolean control function, including aliased controls/targets.
for (let gate_i = 0; gate_i < 16; gate_i++) for (let a = 0; a < 3; a++) for (let b = 0; b < 3; b++) for (let target = 0; target < 3; target++) {
	const input = [{ a, b, target, gate_i }, not, not]
	const result = synthesize(input)
	if (result) equivalent(input, result, 3)
}
const random = seededRandom(20261120)
const pick = (n: number) => Math.floor(random() * n)
for (let wires = 3; wires <= 6; wires++) for (let trial = 0; trial < 20; trial++) {
	const network: Gate[] = Array.from({ length: 30 }, () => {
		const target = pick(wires), controls = Array.from({ length: wires }, (_, i) => i).filter(i => i !== target)
		return { a: controls[pick(controls.length)], b: controls[pick(controls.length)], target, gate_i: pick(16) }
	})
	const input = [...network, ...network.slice().reverse(), not]
	const copy = structuredClone(input), result = synthesize(input)
	assert.deepEqual(result, [not], 'recover affine behavior through arbitrary reversible nonlinear intermediates')
	equivalent(input, result!, wires)
	assert.deepEqual(input, copy)
}
// Copy a dense high-bit polynomial to another wire. The product of the
// identical factors must equal the factor, even when the target aliases it.
const denseFactors = [
	...Array.from({ length: 7 }, (_, i) => ({ a: 63, b: i, target: 63, gate_i: 1 })),
	{ a: 32, b: 0, target: 32, gate_i: 3 },
	{ a: 63, b: 0, target: 32, gate_i: 3 },
]
const denseProduct = [...denseFactors, { a: 32, b: 63, target: 32, gate_i: 1 }]
const reducedProduct = [...denseFactors, { a: 63, b: 0, target: 32, gate_i: 3 }]
const toggleFirst = [{ a: 0, b: 0, target: 0, gate_i: 15 }]
const toggleSecond = [{ a: 0, b: 0, target: 1, gate_i: 15 }]
const proveFirst = createPolynomialEquivalenceChecker(toggleFirst, 2, 20, 100)
const proveSecond = createPolynomialEquivalenceChecker(toggleSecond, 2, 20, 100)
assert.equal(proveFirst(toggleFirst), true)
assert.equal(proveSecond(toggleFirst), false)
assert.equal(proveSecond(toggleSecond), true)
assert.equal(proveFirst(toggleSecond), false)

const denseProof = createPolynomialEquivalenceChecker(denseProduct, 64, 2000, 100_000)
assert.equal(denseProof(reducedProduct), true)
assert.equal(denseProof(denseFactors), false)
assert.equal(createPolynomialEquivalenceChecker(denseProduct, 64, 2000, 10_000)(reducedProduct), undefined)

const disjointProduct = [
	...Array.from({ length: 7 }, (_, i) => ({ a: 32, b: i, target: 32, gate_i: 1 })),
	...Array.from({ length: 7 }, (_, i) => ({ a: 63, b: i + 40, target: 63, gate_i: 1 })),
	{ a: 32, b: 63, target: 31, gate_i: 1 },
]
assert.equal(createPolynomialEquivalenceChecker(disjointProduct, 64, 2000, 100_000)(disjointProduct), undefined)
assert.equal(createPolynomialEquivalenceChecker(disjointProduct, 64, 20_000, 100_000)(disjointProduct), true)

console.log('Mixed symbolic affine synthesis: all control functions and aliases, exhaustive randomized nonlinear cancellations, subwindows, true nonlinear rejection and resource limits passed')
