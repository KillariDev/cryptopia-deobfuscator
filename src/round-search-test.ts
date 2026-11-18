import assert from 'node:assert/strict'
import { roundSearchPlan, roundSearchResult } from './round-search.js'
import { parseConfig } from './config.js'
import { evalCircuit, generateCombinations } from './utils.js'
import { Gate } from './types.js'

assert.deepEqual(roundSearchPlan(1000, 24, 450, 2000), { wholeCircuit: true, capacity: 24 })
assert.deepEqual(roundSearchPlan(1000, 24, 450, 0), { wholeCircuit: false, capacity: 2 })
assert.equal(roundSearchPlan(2000, 8, 500, 2000).wholeCircuit, true)
assert.equal(roundSearchPlan(2001, 8, 500, 2000).wholeCircuit, false)
assert.deepEqual(roundSearchPlan(1000, 1, 450, 2000), { wholeCircuit: false, capacity: 1 })
assert.equal(parseConfig({ workers: { wholeCircuitMaximumGates: 0 } }).workers.wholeCircuitMaximumGates, 0)
assert.throws(() => parseConfig({ workers: { wholeCircuitMaximumGates: -1 } }))
assert.throws(() => parseConfig({ workers: { wholeCircuitMaximumGates: 1.5 } }))

const not: Gate = { a: 0, b: 0, target: 0, gate_i: 15 }
const cn: Gate = { a: 1, b: 0, target: 2, gate_i: 3 }
const original = [cn, not, cn]
const alternatives = [original, [not], original.slice()]
assert.deepEqual(roundSearchResult(alternatives, true), [not])
assert.deepEqual(roundSearchResult([original, original], true), original)
assert.deepEqual(roundSearchResult([original, []], true), [])
assert.throws(() => roundSearchResult([], true))
for (const input of generateCombinations(3)) {
	assert.deepEqual(evalCircuit(roundSearchResult(alternatives, true), input), evalCircuit(original, input))
	// Concatenating two whole-circuit NOT alternatives would incorrectly cancel.
	assert.notDeepEqual(evalCircuit([original, [not]].flat(), input), evalCircuit(original, input))
}
assert.deepEqual(roundSearchResult([[cn], [not], [cn]], false), original)
console.log('Small-circuit full-context capacity, winner selection, equivalence and chunk assembly passed')
