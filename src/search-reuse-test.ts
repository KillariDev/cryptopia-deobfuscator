import assert from 'node:assert/strict'
import sqlite3 from 'sqlite3'
import { LookupFunction } from './lookup-function.js'
import { SlidingWindowWires } from './window-wires.js'
import { NeighborhoodQueue, SearchScheduler } from './search.js'
import { RainbowPortfolio } from './rainbow-portfolio.js'
import { LimitedMap } from './limitedMap.js'
import { runSQL } from './sql.js'
import { Gate } from './types.js'
import { calculateAllOutputsArray, generateCombinations, ioHash, mapVariablesToIndexes, findConvexSubsets } from './utils.js'
import { parseConfig } from './config.js'

let seed = 12629
const random = (n: number) => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return (seed >>> 8) % n }
for (let wires = 0; wires <= 8; wires++) for (let f = 0; f < 16; f++) {
	const gates: Gate[] = wires ? Array.from({ length: 12 }, (_, i) => ({ a: random(wires), b: random(wires), target: random(wires), gate_i: (f + i) % 16 })) : []
	const fn = new LookupFunction(gates, wires)
	for (let width = wires; width <= 8; width++) {
		const expected = ioHash(calculateAllOutputsArray(gates, generateCombinations(width)))
		assert.equal(fn.key(width), expected)
		assert.equal(fn.key(width), expected)
	}
}
assert.throws(() => new LookupFunction([], 9))
assert.throws(() => new LookupFunction([], 3).key(2))

for (let trial = 0; trial < 20; trial++) {
	const gates = Array.from({ length: 25 }, () => ({ a: random(20), b: random(20), target: random(20), gate_i: random(16) }))
	for (let length = 1; length <= gates.length + 1; length++) {
		const windows = new SlidingWindowWires(gates, length)
		let visited = 0
		while (windows.next()) {
			const reference = mapVariablesToIndexes(gates.slice(windows.start, windows.end))
			assert.deepEqual(windows.mapping(), reference)
			assert.equal(windows.wireCount, reference.length)
			visited++
		}
		assert.equal(visited, Math.max(0, gates.length - length + 1))
	}
}

const tables = [{ wires: 3, gates: 1 }, { wires: 3, gates: 2 }, { wires: 4, gates: 2 }].map(spec => ({ ...spec, db: new sqlite3.Database(':memory:') }))
const portfolio = new RainbowPortfolio(tables)
const nativeKey = LookupFunction.prototype.key
const instances = new Set<LookupFunction>()
try {
	for (const table of tables) await runSQL(table.db, 'CREATE TABLE InputOutputReplacers(ioIdentifier BLOB PRIMARY KEY,replacerGates BLOB NOT NULL) WITHOUT ROWID')
	LookupFunction.prototype.key = function(width) { instances.add(this); return nativeKey.call(this, width) }
	await portfolio.findReplacements([{ wires: 2, mappedGates: [{ a: 1, b: 0, target: 0, gate_i: 3 }] }], new LimitedMap(100))
	assert.equal(instances.size, 1, 'fallback across depths/widths shares one function evaluation')
} finally { LookupFunction.prototype.key = nativeKey; await portfolio.close() }

const neighborhoods = new NeighborhoodQueue(5, 4, 3)
for (let round = 1; round <= 9; round++) {
	neighborhoods.afterRewrite(4, 2, 10)
	const seeds = neighborhoods.take()
	assert.ok(seeds.length <= 5)
	assert.equal(seeds.length === 0, round % 3 === 0)
	assert.ok(seeds.every(i => i >= 0 && i < 10))
}
neighborhoods.afterRewrite(0, 0, 0)
assert.deepEqual(neighborhoods.take(), [])
const graphGates = Array.from({ length: 20 }, (_, i) => ({ a: (i + 1) % 4, b: 0, target: i % 4, gate_i: 3 }))
const oldRandom = Math.random
try {
	Math.random = () => 0.5
	const baseline = [...findConvexSubsets(4, graphGates)].map(lines => lines.join(',')).sort()
	Math.random = () => 0.5
	const focused = [...findConvexSubsets(4, graphGates, undefined, undefined, [5, 5, -1, 12, 99])].map(lines => lines.join(',')).sort()
	assert.deepEqual(focused, baseline, 'focus changes priority without dropping broad subsets')
} finally { Math.random = oldRandom }
const scheduler = new SearchScheduler(1000, 0.5)
const a = { subset: 5, slice: 3 }, b = { subset: 10, slice: 3 }
scheduler.record(a, 10, 100); scheduler.record(b, 10, 1)
assert.equal(scheduler.choose([a, b]), a)
for (let i = 0; i < 12; i++) scheduler.record(a, 10, 0)
assert.equal(scheduler.choose([a, b]), b, 'recent failures outweigh old successes')
assert.throws(() => new SearchScheduler(5, 0))

for (const [section, key, invalid] of [['search', 'schedulerDecay', 0], ['search', 'schedulerDecay', 1.1], ['search', 'localSearchSeeds', 0], ['search', 'localSearchRadius', -1], ['search', 'localSearchBroadEvery', 0]] as const) assert.throws(() => parseConfig({ [section]: { [key]: invalid } }))
console.log('Packed lookup reuse, sliding wires, focused search, and scheduler decay regressions passed')
