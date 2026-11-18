import assert from 'node:assert/strict'
import { PeriodicStrategy, WholeCircuitRestart, roundSearchPlan, roundSearchResult } from './round-search.js'
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

const stop = new Int32Array(new SharedArrayBuffer(4))
const saved: Gate[][] = []
const restart = new WholeCircuitRestart(original, stop, candidate => {
	if (!saved.length) assert.equal(Atomics.load(stop, 0), 0, 'persist and verify before signaling peers')
	saved.push(candidate)
})
assert.equal(restart.accept(original.slice()), false, 'equal results do not interrupt searches')
assert.equal(Atomics.load(stop, 0), 0)
assert.equal(restart.accept([not]), true)
assert.equal(Atomics.load(stop, 0), 1)
assert.equal(restart.accept(original), false, 'late stale results cannot replace the new best')
assert.equal(restart.accept([]), true, 'a better result arriving while peers stop is retained')
assert.deepEqual(restart.best, [])
assert.deepEqual(saved, [[not], []])
const failedStop = new Int32Array(new SharedArrayBuffer(4))
const failed = new WholeCircuitRestart(original, failedStop, () => { throw new Error('verification failed') })
assert.throws(() => failed.accept([not]), /verification failed/)
assert.equal(Atomics.load(failedStop, 0), 0)
assert.deepEqual(failed.best, original)
console.log('Verified improvement restart, late winner retention, stale result rejection and failed-save safety passed')

const periodic = new PeriodicStrategy(60_000)
assert.equal(periodic.take(0), true)
for (let round = 1; round < 60; round++) assert.equal(periodic.take(round * 1000), false)
assert.equal(periodic.take(60_000), true)
assert.equal(periodic.take(60_001), false)
assert.equal(new PeriodicStrategy(0).take(0), false)
assert.equal(parseConfig({ synthesis: { affineWholeCircuitSeconds: 0 } }).synthesis.affineWholeCircuitSeconds, 0)
