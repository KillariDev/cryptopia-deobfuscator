import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { synthesizeAffine, simplifyAffineRegions } from './affine.js'
import { config } from './config.js'
import { affineRewrite } from './strategies.js'
import { Gate } from './types.js'
import { evalCircuit, generateCombinations } from './utils.js'
import { seededRandom } from './random.js'

const equivalent = (before: Gate[], after: Gate[], wires: number) => {
	for (const input of generateCombinations(wires)) assert.deepEqual(evalCircuit(after, input), evalCircuit(before, input))
}
const not: Gate = { a: 0, b: 0, target: 0, gate_i: 15 }
assert.equal(synthesizeAffine([not]), undefined, 'do not replace equal-size circuits')
assert.deepEqual(synthesizeAffine([not, not]), [])
const cn: Gate = { a: 0, b: 0, target: 1, gate_i: 3 }
assert.equal(synthesizeAffine([cn, cn], 1), undefined, 'respect the wire bound')
assert.equal(synthesizeAffine([{ a: 0, b: 1, target: 2, gate_i: 1 }]), undefined, 'decline nonlinear controls')
assert.equal(synthesizeAffine([{ a: 0, b: 0, target: 0, gate_i: 3 }, not]), undefined, 'decline singular maps')

// Exercise every affine truth function, complemented controls, and target aliases.
for (const gate_i of [0, 3, 5, 6, 9, 10, 12, 15]) for (let a = 0; a < 3; a++) for (let b = 0; b < 3; b++) for (let target = 0; target < 3; target++) {
	const gate = { a, b, target, gate_i }
	const before = [gate, not, not]
	const result = synthesizeAffine(before)
	if (result) equivalent(before, result, 3)
}
const random = seededRandom(20261118)
const pick = (n: number) => Math.floor(random() * n)
for (let wires = 2; wires <= 6; wires++) for (let trial = 0; trial < 30; trial++) {
	const before: Gate[] = Array.from({ length: 100 }, () => {
		const target = pick(wires), controls = Array.from({ length: wires }, (_, i) => i).filter(i => i !== target)
		return { target, a: controls[pick(controls.length)], b: controls[pick(controls.length)], gate_i: [3, 5, 6, 9, 10, 12, 15][pick(7)] }
	})
	const copy = structuredClone(before), result = synthesizeAffine(before)
	assert.ok(result, 'bounded reversible random circuits should synthesize shorter')
	equivalent(before, result, wires)
	assert.deepEqual(before, copy, 'synthesis must not mutate the input')
}
const back: Gate = { a: 1, b: 0, target: 0, gate_i: 3 }
const swap = [cn, back, cn, not, not]
const swapped = synthesizeAffine(swap)!
assert.ok(swapped.length < swap.length)
equivalent(swap, swapped, 2)
const nonlinear: Gate = { a: 0, b: 1, target: 2, gate_i: 1 }
const mixed = [cn, cn, nonlinear, cn, cn, not]
const reduced = simplifyAffineRegions(mixed)
assert.deepEqual(reduced, [nonlinear, not])
equivalent(mixed, reduced, 3)
assert.equal(simplifyAffineRegions([nonlinear])[0], nonlinear)
const saved = config.synthesis.affine
try {
	config.synthesis.affine = false
	assert.equal(affineRewrite(mixed), mixed)
	config.synthesis.affine = true
	assert.deepEqual(affineRewrite(mixed), reduced)
} finally { config.synthesis.affine = saved }

const challenge = JSON.parse(readFileSync(new URL('../data/tangled-not.json', import.meta.url), 'utf8'))
const gates: Gate[] = challenge.gates.map(([a, b, target, gate_i]: number[]) => ({ a, b, target, gate_i }))
assert.deepEqual(synthesizeAffine(gates), [not], 'solve the complete 32-wire tangled NOT challenge')
// High wire labels check that BigInt matrices and remapping preserve all wires.
const high: Gate[] = [{ a: 63, b: 0, target: 31, gate_i: 3 }, { a: 63, b: 0, target: 31, gate_i: 3 }, { ...not, target: 63 }]
assert.deepEqual(synthesizeAffine(high), [{ ...not, target: 63 }])
console.log('GF(2) affine synthesis: exhaustive random maps, controls, swaps, aliases, nonlinear boundaries, sparse wires, disable switch and tangled NOT challenge passed')
