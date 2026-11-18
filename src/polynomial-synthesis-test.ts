import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { synthesizePolynomial, searchPolynomialRegions } from './symbolic-affine.js'
import { emitQuadraticMap } from './polynomial-synthesis.js'
import { advancedRewrite } from './strategies.js'
import { config } from './config.js'
import { evalCircuit, generateCombinations, verifyCircuit } from './utils.js'
import { seededRandom } from './random.js'
import { Gate } from './types.js'
const synthesize = (input: Gate[]) => synthesizePolynomial(input, 64, 100000, 10000000)
const not: Gate = { a: 0, b: 0, target: 0, gate_i: 15 }
const padding = Array.from({ length: 10 }, () => ({ ...not }))
const equivalent = (before: Gate[], after: Gate[], wires: number) => {
	for (const input of generateCombinations(wires)) assert.deepEqual(evalCircuit(after, input), evalCircuit(before, input))
}
const toffoli: Gate = { a: 0, b: 1, target: 2, gate_i: 1 }
assert.deepEqual(synthesize([toffoli, ...padding]), [toffoli])
const complemented = { ...toffoli, gate_i: 14 }
assert.deepEqual(synthesize([complemented, ...padding]), [complemented])
assert.equal(synthesize([toffoli]), undefined, 'require strictly fewer gates')
const chain = [toffoli, { a: 2, b: 0, target: 3, gate_i: 3 }, ...padding]
const ordered = synthesize(chain)!
assert.equal(ordered.length, 3)
assert.equal(ordered[0].target, 3)
assert.equal(ordered.at(-1)!.target, 2, 'emit users of the original control before mutating that control')
equivalent(chain, ordered, 4)
const cubic = [toffoli, { a: 2, b: 3, target: 4, gate_i: 1 }, ...padding]
assert.equal(synthesize(cubic), undefined, 'decline higher degree maps')
const fredkin = [{ a: 1, b: 0, target: 2, gate_i: 3 }, { a: 0, b: 2, target: 1, gate_i: 1 }, { a: 1, b: 0, target: 2, gate_i: 3 }, ...padding]
assert.equal(synthesize(fredkin), undefined, 'decline target-dependent nonlinear deltas')
assert.equal(emitQuadraticMap([new Set([1n, 6n]), new Set([2n, 5n]), new Set([4n])], [0, 1, 2], 20, () => false), undefined, 'decline dependency cycles')
assert.equal(synthesizePolynomial(chain, 64, 100000, 10000000, -Infinity), undefined)
assert.equal(synthesizePolynomial(chain, 64, 100000, 10000000, Infinity, () => true), undefined)
assert.equal(synthesizePolynomial(chain, 64, 2, 10000000), undefined)
assert.equal(synthesizePolynomial(chain, 64, 100000, 1), undefined)
const random = seededRandom(20261121), pick = (n: number) => Math.floor(random() * n)
for (let wires = 3; wires <= 6; wires++) for (let trial = 0; trial < 20; trial++) {
	const controls = Math.max(2, Math.floor(wires / 2))
	const core: Gate[] = Array.from({ length: 8 }, () => ({ a: pick(controls), b: pick(controls), target: controls + pick(wires - controls), gate_i: pick(16) }))
	const garbling: Gate[] = Array.from({ length: 20 }, () => {
		const target = pick(wires), available = Array.from({ length: wires }, (_, i) => i).filter(i => i !== target)
		return { target, a: available[pick(available.length)], b: available[pick(available.length)], gate_i: pick(16) }
	})
	const input = [...garbling, ...garbling.slice().reverse(), ...core]
	const copy = structuredClone(input), result = synthesize(input)
	assert.ok(result && result.length < input.length)
	equivalent(input, result, wires)
	assert.deepEqual(input, copy)
}
const saved = { ...config.synthesis }
try {
	Object.assign(config.synthesis, { factored: false, blockCancellation: false, satSweeping: false, quadratic: true, affine: false, templates: false, forwardSemanticSearch: false, smt: false, meetInMiddle: false, equalitySaturation: false })
	assert.deepEqual(await advancedRewrite([toffoli, ...padding]), [toffoli])
	config.synthesis.quadratic = false
	assert.equal(await advancedRewrite([toffoli, ...padding]), undefined)
} finally { Object.assign(config.synthesis, saved) }
const maze = JSON.parse(readFileSync(new URL('../data/recursive-affine-maze.json', import.meta.url), 'utf8'))
const gates: Gate[] = maze.gates.map(([a,b,target,gate_i]: number[]) => ({a,b,target,gate_i}))
const result = synthesize(gates)!
assert.equal(result.length, 4)
assert.deepEqual(new Set(result.map(g => g.target)), new Set([16, 17, 18, 20]))
verifyCircuit(gates, result, 32, 256)
assert.equal(searchPolynomialRegions(gates, 64, 100000, 10000000, performance.now() + 5000).length, 4)
console.log('Quadratic synthesis: exact maze solution, exhaustive randomized garbling, dependency order, complemented gates, unsupported maps, limits and strategy selection passed')
