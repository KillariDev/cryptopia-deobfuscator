import assert from 'node:assert/strict'
import sqlite3 from 'sqlite3'
import { broadRegions, broadSearch } from './broad-search.js'
import { config, minimumBroadGates } from './config.js'
import { createOptimizerCaches, massOptimizeStep } from './processing.js'
import { RainbowPortfolio } from './rainbow-portfolio.js'
import { functionKey, encodeGates } from './semantic.js'
import { runSQL } from './sql.js'
import { calculateAllOutputsArray, generateCombinations } from './utils.js'
import { Gate } from './types.js'
import { strategySnapshot, resetStrategyStats } from './strategy-stats.js'
const regions = [...broadRegions(40)]
assert.deepEqual(regions[0], { start: 0, end: 40 })
assert.deepEqual(regions.filter(region => region.end - region.start === 20), [{ start: 0, end: 20 }, { start: 10, end: 30 }, { start: 20, end: 40 }])
assert.ok(regions.every(region => region.start >= 0 && region.end <= 40 && region.end > region.start))
assert.equal(new Set(regions.map(region => `${region.start}:${region.end}`)).size, regions.length)
assert.deepEqual([...broadRegions(0)], [])
const saved = structuredClone(config)
const db = new sqlite3.Database(':memory:')
const tables = new RainbowPortfolio([{ wires: 3, gates: 1, db }])
try {
	config.search.strategyAdaptive = false
	// This case isolates contiguous broad windows; global cuts have separate
	// integration coverage and may find a smaller improvement first.
	config.search.dependencyCuts = false
	Object.assign(config.synthesis, { factored: false, blockCancellation: false, satSweeping: false, mixedBasis: false, quadratic: false, affine: false, templates: false, forwardSemanticSearch: false, smt: false, meetInMiddle: false, equalitySaturation: false })
	config.search.probabilistic = false
	config.search.variableElimination = false
	await runSQL(db, 'CREATE TABLE InputOutputReplacers(ioIdentifier BLOB PRIMARY KEY,replacerGates BLOB NOT NULL) WITHOUT ROWID')
	await runSQL(db, 'INSERT INTO InputOutputReplacers VALUES (?,?)', [Buffer.from(functionKey([], 3), 'hex'), encodeGates([])])
	const prefix: Gate[] = Array.from({ length: 1250 }, () => ({ a: 0, b: 1, target: 2, gate_i: 1 }))
	const middle: Gate[] = Array.from({ length: 2500 }, () => ({ a: 6, b: 0, target: 7, gate_i: 3 }))
	const suffix: Gate[] = Array.from({ length: 1250 }, () => ({ a: 3, b: 4, target: 5, gate_i: 1 }))
	const input = [...prefix, ...middle, ...suffix]
	const nativeFind = tables.findReplacements.bind(tables)
	const small = middle.slice(0, minimumBroadGates() - 1)
	for (const adaptive of [false, true]) {
		config.search.strategyAdaptive = adaptive
		resetStrategyStats()
		assert.equal(await broadSearch(tables, small, 8, createOptimizerCaches(), 5000, () => false, () => {}), small)
		assert.deepEqual(strategySnapshot(), [], 'broad search leaves local-sized circuits to local workers')
	}
	config.search.strategyAdaptive = false
	let largestWindow = 0
	tables.findReplacements = async (windows, cache) => {
		for (const window of windows) largestWindow = Math.max(largestWindow, window.mappedGates.length)
		return nativeFind(windows, cache)
	}
	const result = await broadSearch(tables, input, 8, createOptimizerCaches(), 5000, () => false, () => {})
	assert.equal(largestWindow, 2500, 'rainbow scans a large region spanning the normal split at gate 2500')
	assert.deepEqual(result, [...prefix, ...suffix])
	assert.deepEqual(calculateAllOutputsArray(result, generateCombinations(8)), calculateAllOutputsArray(input, generateCombinations(8)))
	const dense: Gate[] = Array.from({ length: 5000 }, (_, i) => ({ a: 0, b: 0, target: i % 2, gate_i: 15 }))
	let batches = 0, largestBatch = 0
	tables.findReplacements = async (windows, cache) => {
		batches++; largestBatch = Math.max(largestBatch, windows.length)
		return nativeFind(windows, cache)
	}
	assert.deepEqual((await massOptimizeStep(tables, createOptimizerCaches().ioIdentifierCache, createOptimizerCaches().processedGatesCache, dense, 2500, false, false)).gates, [])
	assert.ok(batches > 1 && largestBatch <= 40, 'large overlapping queries are streamed, not retained quadratically')
	config.search.variableElimination = true
	const variables: Gate[] = Array.from({ length: 2500 }, (_, i) => ({ a: 0, b: 0, target: i % 2, gate_i: 15 }))
	resetStrategyStats()
	assert.deepEqual(await broadSearch(tables, variables, 2, createOptimizerCaches(), 5000, () => false, () => {}), [])
	assert.ok(strategySnapshot().some(stat => stat.strategy === 'variables' && JSON.parse(stat.settings).slice === 2500), 'variable elimination gets the full large window too')
	assert.equal(await broadSearch(tables, variables, 2, createOptimizerCaches(), 5000, () => true, () => {}), variables)
} finally {
	Object.assign(config, saved)
	await tables.close()
}
console.log('Broad toolkit: overlapping multi-scale regions, cross-chunk 2500-gate rainbow and variable scans, exact equivalence and cancellation passed')

// A broad and local job must both start; queued old-baseline work is canceled.
const { WorkerPool } = await import('./threads.js')
const { WholeCircuitRestart, roundSearchResult } = await import('./round-search.js')
const fixture = new URL('data:text/javascript,' + encodeURIComponent(`
import {parentPort} from 'node:worker_threads';
parentPort.on('message', async ({gates,solver,stopSignal,sharedTemplates}) => {
 if(sharedTemplates !== undefined) return;
 const signal = new Int32Array(stopSignal);
 Atomics.store(signal, solver === 'broad' ? 1 : 2, 1);
 parentPort.postMessage({progress:gates.length});
 while(!Atomics.load(signal,0)) await new Promise(resolve=>setTimeout(resolve,1));
 parentPort.postMessage({gates});
});`))
const pool = new WorkerPool(2, fixture)
const signal = new Int32Array(new SharedArrayBuffer(12))
let queuedRan = false
const gate: Gate = { a: 0, b: 0, target: 0, gate_i: 15 }
const stopped = () => { if (Atomics.load(signal, 1) && Atomics.load(signal, 2)) Atomics.store(signal, 0, 1) }
try {
	const broad = pool.run([gate], 1, stopped, signal.buffer as SharedArrayBuffer, 1000, true, 'broad')
	const local = pool.run([gate], 1, stopped, signal.buffer as SharedArrayBuffer, 1000)
	const queued = pool.run([gate], 1, () => { queuedRan = true }, signal.buffer as SharedArrayBuffer, 1000)
	assert.deepEqual(await Promise.all([broad, local, queued]), [[gate], [gate], [gate]])
	assert.equal(queuedRan, false)
	assert.equal(Atomics.load(signal, 1), 1)
	assert.equal(Atomics.load(signal, 2), 1)
} finally { await pool.close() }
const stop = new Int32Array(new SharedArrayBuffer(4))
const original = [gate, gate, gate]
const restart = new WholeCircuitRestart(original, stop, candidate => {
	for (const input of generateCombinations(1)) assert.deepEqual(calculateAllOutputsArray(candidate, [input]), calculateAllOutputsArray(original, [input]))
})
restart.accept([gate])
const oldChunks = [[gate, gate], [gate]]
const winner = roundSearchResult([restart.best, roundSearchResult(oldChunks, false)], true)
assert.deepEqual(winner, [gate], 'never concatenate a whole-circuit result with chunks from the old baseline')
console.log('Broad/local concurrency, queued cancellation and complete-candidate isolation passed')

const { findMatchingOperation } = await import('./processing.js')
let polls = 0
assert.equal(findMatchingOperation(Array.from({ length: 10000 }, (_, target) => ({ a: 0, b: 1, target, gate_i: 1 })), () => { polls++; return true }), undefined)
assert.ok(polls > 0, 'large variable-combination scans observe cancellation inside their pair loop')
