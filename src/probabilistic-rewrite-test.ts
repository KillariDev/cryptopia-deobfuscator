import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { config } from './config.js'
import { Gate } from './types.js'
import { createPolynomialEquivalenceChecker } from './symbolic-affine.js'
import { areCircuitsProbabilisticallyTheSame, massOptimizeStep } from './processing.js'
import { evalCircuit, generateCombinations, mapCircuit, mapVariablesToIndexes } from './utils.js'
import { RainbowPortfolio } from './rainbow-portfolio.js'
import { LimitedMap } from './limitedMap.js'
import sqlite3 from 'sqlite3'

const fixture = JSON.parse(readFileSync(new URL('../proofs/nonlinear-basis-maze-corruption.json', import.meta.url), 'utf8'))
const gates = (rows: number[][]): Gate[] => rows.map(([a, b, target, gate_i]) => ({ a, b, target, gate_i }))
const before = gates(fixture.before), bad = gates(fixture.incorrect_after)
const mapping = mapVariablesToIndexes(before)
let differences = 0
for (const input of generateCombinations(mapping.length)) {
	if (JSON.stringify(evalCircuit(mapCircuit(before, mapping), input)) !== JSON.stringify(evalCircuit(mapCircuit(bad, mapping), input))) differences++
}
assert.equal(differences, 32)
assert.equal(2 ** mapping.length, 2048)
assert.equal(createPolynomialEquivalenceChecker(before, 64, 100000, 10000000)(bad), false)
// Check the admission proof against complete truth tables, including aliases.
const smallInputs = generateCombinations(3)
for (let gate_i = 0; gate_i < 16; gate_i++) for (let a = 0; a < 3; a++) for (let b = 0; b < 3; b++) for (let target = 0; target < 3; target++) {
	const circuit = [{ a, b, target, gate_i }]
	const proof = createPolynomialEquivalenceChecker(circuit, 3, 100000, 10000000)
	assert.equal(proof(circuit), true)
	assert.equal(proof([]), smallInputs.every(input => JSON.stringify(evalCircuit(circuit, input)) === JSON.stringify(input)))
}

// Construct a guaranteed miss in the actual fixed 202-input sampling pool.
// There are 256 control patterns beginning with 11, so at least one is absent.
const inputs: boolean[][] = []
assert.equal(areCircuitsProbabilisticallyTheSame(inputs, [], [], 202, 20), true)
const patternOf = (input: boolean[]) => input.slice(0, 10).reduce((mask, value, i) => mask | (Number(value) << i), 0)
const seen = new Set(inputs.map(patternOf))
const missing = Array.from({ length: 1024 }, (_, i) => i).find(pattern => (pattern & 3) === 3 && !seen.has(pattern))!
assert.notEqual(missing, undefined)
const basis: Gate[] = [{ a: 0, b: 1, target: 10, gate_i: 1 }]
for (let control = 2; control < 10; control++) basis.push({ a: control + 8, b: control, target: control + 9, gate_i: missing & (1 << control) ? 1 : 2 })
const center: Gate = { a: 18, b: 0, target: 19, gate_i: 3 }
const original = [...basis, center, ...basis.slice().reverse()]
const candidate = [...basis.slice(1), center, ...basis.slice(1).reverse()]
assert.equal(areCircuitsProbabilisticallyTheSame([], original, candidate, 202, 20), true, 'all sampled inputs miss the rare difference')
const witness = Array.from({ length: 20 }, (_, i) => i < 10 && !!(missing & (1 << i)))
assert.notDeepEqual(evalCircuit(original, witness), evalCircuit(candidate, witness))
assert.equal(createPolynomialEquivalenceChecker(original, 20, 100000, 10000000)(candidate), false)
assert.equal(createPolynomialEquivalenceChecker(original, 20, 1, 10000000)(candidate), undefined)
assert.equal(createPolynomialEquivalenceChecker(original, 20, 100000, 1)(candidate), undefined)
assert.equal(createPolynomialEquivalenceChecker(original, 20, 100000, 10000000, () => true)(candidate), undefined)

const saved = structuredClone(config), tables = new RainbowPortfolio([{ wires: 3, gates: 3, db: new sqlite3.Database(':memory:') }])
try {
	config.search.strategyAdaptive = false
	Object.assign(config.synthesis, { templates: false, affine: false, quadratic: false, forwardSemanticSearch: false, smt: false, meetInMiddle: false, equalitySaturation: false })
	const optimize = (input: Gate[]) => massOptimizeStep(tables, new LimitedMap(100), new LimitedMap(100), input, input.length, true, true, false)
	assert.equal((await optimize(original)).changed, false, 'do not admit a sampled false positive through the real variable strategy')
	const valid = [...basis, ...basis.slice().reverse(), { a: 0, b: 0, target: 19, gate_i: 15 }]
	const result = await optimize(valid)
	assert.equal(result.changed, true, 'continue to accept provable wide variable rewrites')
	assert.equal(createPolynomialEquivalenceChecker(valid, 20, 100000, 10000000)(result.gates), true)
	config.synthesis.affineMaximumOperations = 1
	assert.equal((await optimize(valid)).changed, false, 'an inconclusive proof must decline the rewrite')
} finally { Object.assign(config, saved); await tables.close() }
console.log('Probabilistic rewrite admission: actual corruption, guaranteed sampling miss, exact rejection, valid rewrites, resource limits and cancellation passed')
