import assert from 'node:assert/strict'
import sqlite3 from 'sqlite3'
import { broadRegions, broadSearch } from './broad-search.js'
import { config, minimumBroadGates, parseConfig } from './config.js'
import { broadStrategyOrder, createOptimizerCaches, massOptimizeStep } from './processing.js'
import { RainbowPortfolio } from './rainbow-portfolio.js'
import { functionKey, encodeGates } from './semantic.js'
import { runSQL } from './sql.js'
import { calculateAllOutputsArray, generateCombinations } from './utils.js'
import { Gate } from './types.js'
import { emitBorrowedProduct, synthesizeDecisionDiagramProduct } from './decision-diagram-product.js'
import { createPolynomialEquivalenceChecker } from './symbolic-affine.js'
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
	config.search.broadStrategyOrder = []
	config.search.strategyAdaptive = false
	// This case isolates contiguous broad windows; global cuts have separate
	// integration coverage and may find a smaller improvement first.
	config.search.dependencyCuts = false
	Object.assign(config.synthesis, { decisionDiagramProduct: false, factored: false, blockCancellation: false, satSweeping: false, mixedBasis: false, quadratic: false, quadraticShear: false, affine: false, forwardSemanticSearch: false, smt: false, meetInMiddle: false, equalitySaturation: false })
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
	config.search.variableElimination = true
	let lookups = 0
	tables.findReplacements = async (windows, cache) => {
		lookups++
		return nativeFind(windows, cache)
	}
	for (const adaptive of [false, true]) {
		config.search.strategyAdaptive = adaptive
		resetStrategyStats()
		assert.equal(await broadSearch(tables, input, 8, createOptimizerCaches(), 5000, () => false, () => {}), input)
		assert.deepEqual(strategySnapshot(), [], 'global search skips standalone variable and rainbow passes')
	}
	assert.equal(lookups, 0)
	config.search.strategyAdaptive = false
	const dense: Gate[] = Array.from({ length: 5000 }, (_, i) => ({ a: 0, b: 0, target: i % 2, gate_i: 15 }))
	let batches = 0, largestBatch = 0
	tables.findReplacements = async (windows, cache) => {
		batches++; largestBatch = Math.max(largestBatch, windows.length)
		return nativeFind(windows, cache)
	}
	assert.deepEqual((await massOptimizeStep(tables, createOptimizerCaches().ioIdentifierCache, createOptimizerCaches().processedGatesCache, dense, 2500, false, false)).gates, [])
	assert.ok(batches > 1 && largestBatch <= 40, 'large overlapping queries are streamed, not retained quadratically')
	config.synthesis.factored = true
	for (const adaptive of [false, true]) {
		config.search.strategyAdaptive = adaptive
		resetStrategyStats()
		assert.deepEqual(await broadSearch(tables, input, 8, createOptimizerCaches(), 5000, () => false, () => {}), [])
		assert.ok(strategySnapshot().some(stat => stat.strategy === 'factored-synthesis'))
		assert.equal(await broadSearch(tables, input, 8, createOptimizerCaches(), 5000, () => true, () => {}), input)
	}
	config.synthesis.factored = false
	config.synthesis.quadraticShear = true
	const fittingInput: Gate[] = [
		...middle,
		{ a: 0, b: 3, target: 7, gate_i: 1 },
		{ a: 3, b: 0, target: 7, gate_i: 3 },
		{ a: 0, b: 0, target: 2, gate_i: 15 },
	]
	for (const adaptive of [false, true]) {
		config.search.strategyAdaptive = adaptive
		resetStrategyStats()
		const fitted = await broadSearch(tables, fittingInput, 8, createOptimizerCaches(), 5000, () => false, () => {})
		assert.equal(fitted.length, 2)
		const inputs = generateCombinations(8)
		assert.deepEqual(calculateAllOutputsArray(fitted, inputs), calculateAllOutputsArray(fittingInput, inputs))
		assert.ok(strategySnapshot().some(stat => stat.strategy === 'polynomial-shear-interpolation'))
	}
	const { polynomialShearRegions, polynomialShearSampleCount, synthesizePolynomialShear } = await import('./polynomial-shear.js')
	const wide = [...fittingInput, ...Array.from({ length: 14 }, (_, target) => {
		const gate = { a: 0, b: 0, target, gate_i: 15 }
		return [gate, gate]
	}).flat()]
	const assertFit = (gates: Gate[], expectedLength: number, width: number) => {
		const fitted = synthesizePolynomialShear(gates, 64, 1, 10000000, () => false)
		assert.equal(fitted?.length, expectedLength)
		const inputs = generateCombinations(width)
		assert.deepEqual(calculateAllOutputsArray(fitted!, inputs), calculateAllOutputsArray(gates, inputs))
	}
	const product = { a: 0, b: 1, target: 2, gate_i: 1 }
	const packed = [product, { ...product, gate_i: 3 }, { ...product, gate_i: 5 }]
	assertFit(packed, 1, 3)
	const change = { a: 3, b: 0, target: 0, gate_i: 3 }
	assertFit([product, change, change, change], 2, 4)
	const shared = [1, 2, 3, 4].flatMap(b => [5, 6].map(target => ({ a: 0, b, target, gate_i: 1 })))
	assertFit(shared, 6, 7)
	assert.equal(polynomialShearSampleCount(81026, 64, 4096), 28672)
	assert.ok(polynomialShearSampleCount(81026, 64, 4096) > polynomialShearSampleCount(1024, 16, 4096))
	assert.ok(polynomialShearSampleCount(81026, 64, 100000) >= 100000)
	assert.deepEqual([...polynomialShearRegions([change, { ...product, gate_i: 15 }, change, { ...product, gate_i: 0 }], 4, 2)], [{ start: 0, end: 3 }])
	const proofTermLimit = config.synthesis.affineMaximumTerms
	try {
		config.synthesis.affineMaximumTerms = 1
		config.search.strategyAdaptive = true
		const caches = createOptimizerCaches()
		const strict = await massOptimizeStep(tables, caches.ioIdentifierCache, caches.processedGatesCache, wide,
			wide.length, false, false, false, undefined,
			{ deadline: performance.now() + 5000, broad: true, selectedStrategy: 'polynomial-shear-interpolation' })
		assert.equal(strict.changed, false)
		config.search.probabilistic = true
		const fitted = await broadSearch(tables, wide, 14, createOptimizerCaches(), 5000, () => false, () => {})
		assert.equal(fitted.length, 2)
		assert.ok(strategySnapshot().some(stat => stat.settings.includes('"verification":"sampled"')))
		const inputs = generateCombinations(14)
		assert.deepEqual(calculateAllOutputsArray(fitted, inputs), calculateAllOutputsArray(wide, inputs))
	} finally {
		config.synthesis.affineMaximumTerms = proofTermLimit
		config.search.probabilistic = false
	}
	assert.equal(synthesizePolynomialShear(wide, 64, 1, 10000000, () => false), undefined, 'a fit cannot bypass the proof budget')
	assert.equal(synthesizePolynomialShear(wide, 64, 100000, 10000000, () => true), undefined)
	const compute = { a: 0, b: 1, target: 3, gate_i: 1 }
	const cubic: Gate[] = [compute, { a: 2, b: 3, target: 4, gate_i: 1 }, compute]
	assert.equal(synthesizePolynomialShear(cubic, 64, 1, 10000000, () => false, 4096), undefined)

	// A borrowed wire is restored for either starting value, and a shared
	// control pair only needs one compute/restore sequence.
	const triple = (target: number) => {
		const flip = { a: 3, b: 2, target, gate_i: 1 }
		return [compute, flip, compute, flip]
	}
	assertFit([...triple(4), ...triple(5)], 6, 6)
	const borrow = triple(4)
	const quarticFlip = { a: 4, b: 5, target: 6, gate_i: 1 }
	const quartic = [...borrow, quarticFlip, ...borrow, quarticFlip]
	assert.equal(synthesizePolynomialShear(quartic, 64, 1, 10000000, () => false, 4096), undefined)
	const secondQuarticFlip = { ...quarticFlip, b: 7, target: 8 }
	const secondQuartic = [...borrow, secondQuarticFlip, ...borrow, secondQuarticFlip]
	assertFit([...quartic, ...secondQuartic], 12, 9)
	const linear = { a: 0, b: 0, target: 8, gate_i: 3 }
	assertFit([...quartic, ...secondQuartic, ...triple(9), linear], 17, 10)

	const toggleProduct = (inputs: number[], target: number, scratch: number[]): Gate[] => {
		const [a, ...rest] = inputs
		if (rest.length === 1) return [{ a, b: rest[0], target, gate_i: 1 }]
		const [borrowed, ...remaining] = scratch
		const compute = toggleProduct(rest, borrowed, remaining)
		const flip = { a: borrowed, b: a, target, gate_i: 1 }
		return [...compute, flip, ...compute, flip]
	}
	assert.equal(parseConfig({}).synthesis.quadraticShearMaximumDegree, 8)
	assert.throws(() => parseConfig({ strategies: { polynomialShearInterpolation: { maximumDegree: 1 } } }), /maximumDegree/)
	for (const degree of [5, 6]) {
		const inputs = Array.from({ length: degree }, (_, i) => i)
		const scratch = Array.from({ length: degree - 2 }, (_, i) => i + degree)
		const gates = [2 * degree - 2, 2 * degree - 1].flatMap(target => [
			...toggleProduct(inputs, target, scratch), { a: 0, b: 0, target, gate_i: 3 },
		])
		assertFit(gates, degree === 5 ? 26 : 50, 2 * degree)
		const caches = createOptimizerCaches()
		const solve = () => massOptimizeStep(tables, caches.ioIdentifierCache, caches.processedGatesCache, gates,
			gates.length, false, false, false, undefined,
			{ deadline: performance.now() + 5000, selectedStrategy: 'polynomial-shear-interpolation' })
		const previousDegree = config.synthesis.quadraticShearMaximumDegree
		try {
			config.synthesis.quadraticShearMaximumDegree = parseConfig({
				strategies: { polynomialShearInterpolation: { maximumDegree: degree - 1 } },
			}).synthesis.quadraticShearMaximumDegree
			assert.equal((await solve()).changed, false)
			config.synthesis.quadraticShearMaximumDegree = degree
			assert.equal((await solve()).gates.length, degree === 5 ? 26 : 50)
		} finally {
			config.synthesis.quadraticShearMaximumDegree = previousDegree
		}
	}




	// The global degree-four domain already exceeds the probe cap across these
	// 48 controls. Each target only requires five controls, and every stable
	// wire is used somewhere, so borrowing must happen within each group.
	const wideSparse = Array.from({ length: 16 }, (_, i) => {
		const controls = Array.from({ length: 5 }, (_, offset) => (3 * i + offset) % 48)
		const scratch = Array.from({ length: 3 }, (_, offset) => (3 * i + 5 + offset) % 48)
		return [
			...toggleProduct(controls, 48 + i, scratch),
			...controls.map(a => ({ a, b: 0, target: 48 + i, gate_i: 3 })),
		]
	}).flat()
	let wideVerification: string | undefined
	const wideResult = synthesizePolynomialShear(wideSparse, 64, 100000, 10000000, () => false, 0,
		outcome => { wideVerification = outcome.verification })
	assert.ok(wideResult && wideResult.length < wideSparse.length)
	assert.equal(wideVerification, 'polynomial')

	// Repeated fitting from zero would exceed the cumulative work cap at
	// degree nine. Reusing all lower-weight probes keeps this region in budget.
	const ninthControls = Array.from({ length: 9 }, (_, i) => i)
	const ninthScratch = Array.from({ length: 7 }, (_, i) => i + 9)
	const ninth = [16, 17].flatMap(target => [
		...toggleProduct(ninthControls, target, ninthScratch), { a: 0, b: 0, target, gate_i: 3 },
	])
	while (ninth.length < 20_000) {
		const padding = { a: 0, b: 0, target: 0, gate_i: 15 }
		ninth.push(padding, padding)
	}
	let ninthVerification: string | undefined
	const ninthResult = synthesizePolynomialShear(ninth, 18, 100000, 10000000, () => false, 0,
		outcome => { ninthVerification = outcome.verification }, 9)
	assert.equal(ninthResult?.length, 386)
	assert.equal(ninthVerification, 'polynomial')


	// Exercise the strategy on a region whose positive product is above
	// the interpolation degree cap and restores initially dirty scratch.
	const factors = Array.from({ length: 20 }, (_, i) => i)
	const borrowed = Array.from({ length: 18 }, (_, i) => i + 20)
	const rareProduct = Array.from({ length: 33 }, (_, i) => {
		const offset = i % factors.length
		return emitBorrowedProduct([...factors.slice(offset), ...factors.slice(0, offset)], borrowed, 38)
	}).flat()
	const proveProduct = createPolynomialEquivalenceChecker(rareProduct, 39, 100000, 10000000)
	const productOrder = parseConfig({
		strategies: { decisionDiagramProduct: { enabled: true } },
		search: { localStrategyOrder: ['decision-diagram-product'], broadStrategyOrder: ['decision-diagram-product'] },
	})
	const productStep = () => {
		const caches = createOptimizerCaches()
		return massOptimizeStep(tables, caches.ioIdentifierCache, caches.processedGatesCache, rareProduct,
			rareProduct.length, false, false, false, undefined, { deadline: performance.now() + 5000, forceStrategy: true }, caches.strategyPicker)
	}
	config.search.localStrategyOrder = productOrder.search.localStrategyOrder
	config.search.broadStrategyOrder = productOrder.search.broadStrategyOrder
	assert.equal((await productStep()).changed, false, 'disabled strategy is excluded even when prioritized')
	config.synthesis.decisionDiagramProduct = productOrder.synthesis.decisionDiagramProduct
	const localProduct = await productStep()
	assert.equal(localProduct.gates.length, 72)
	assert.equal(proveProduct(localProduct.gates), true)
	const broadProduct = await broadSearch(tables, rareProduct, 39, createOptimizerCaches(), 5000, () => false, () => {})
	assert.equal(broadProduct.length, 72)
	assert.equal(proveProduct(broadProduct), true)
	assert.ok(strategySnapshot().some(stat => stat.strategy === 'decision-diagram-product' && stat.rewrites))
	assert.equal(synthesizeDecisionDiagramProduct(rareProduct, 38, () => false), undefined)
	assert.equal(synthesizeDecisionDiagramProduct(rareProduct, 64, () => true), undefined)
	assert.equal(synthesizeDecisionDiagramProduct([...rareProduct, { a: 0, b: 0, target: 20, gate_i: 15 }], 64, () => false), undefined)
	const sparseProduct = rareProduct.map(({ a, b, target, gate_i }) => ({ a: 2 * a, b: 2 * b, target: 2 * target, gate_i }))
	const sparseResult = synthesizeDecisionDiagramProduct(sparseProduct, 64, () => false)
	assert.deepEqual(sparseResult?.gates, localProduct.gates.map(({ a, b, target, gate_i }) => ({ a: 2 * a, b: 2 * b, target: 2 * target, gate_i })))
	// Reversing the labels puts every dirty wire before the controls in
	// numeric order. The circuit-derived order should be identical.
	const reverseWires = ({ a, b, target, gate_i }: Gate): Gate => ({ a: 38 - a, b: 38 - b, target: 38 - target, gate_i })
	const reversedProduct = rareProduct.map(reverseWires)
	const reversedResult = synthesizeDecisionDiagramProduct(reversedProduct, 64, () => false)
	assert.equal(reversedResult?.orderingTrials, 0)
	assert.deepEqual(reversedResult?.gates, localProduct.gates.map(reverseWires))
	assert.equal(createPolynomialEquivalenceChecker(reversedProduct, 39, 100000, 10000000)(reversedResult!.gates), true)
	// Restored NOTs make every wire appear written, with dirty wires first.
	// Keep the previous numeric ordering available for cases like this.
	const restoredWrites = Array.from({ length: 39 }, (_, i) => ({ a: 0, b: 0, target: 38 - i, gate_i: 15 }))
		.flatMap(gate => [gate, gate])
	const writtenProduct = [...restoredWrites, ...rareProduct]
	const fallbackResult = synthesizeDecisionDiagramProduct(writtenProduct, 64, () => false)
	assert.equal(fallbackResult?.gates.length, 72)
	assert.equal(createPolynomialEquivalenceChecker(writtenProduct, 39, 100000, 10000000)(fallbackResult!.gates), true)
	// Paired XOR masks need an order that keeps each pair together.
	const pairLeft = factors.slice(0, 18)
	const pairRight = pairLeft.map(wire => wire + 18)
	const pairScratch = borrowed.slice(0, 16).map(wire => wire + 16)
	const basis = pairLeft.map((a, i) => ({ a, b: a, target: pairRight[i], gate_i: 3 }))
	const mask = [...basis, ...emitBorrowedProduct(pairRight, pairScratch, 52), ...basis.slice().reverse()]
	const payload = emitBorrowedProduct(pairLeft.slice(0, 10), pairScratch, 52)
	const lateMask = [
		...Array.from({ length: 256 }, () => ({ a: 0, b: 0, target: 0, gate_i: 15 })),
		...mask, ...payload, ...mask,
	]
	assert.equal(synthesizeDecisionDiagramProduct(lateMask, 64, () => false, 'off'), undefined)
	const adaptiveResult = synthesizeDecisionDiagramProduct(lateMask, 64, () => false)
	assert.ok(adaptiveResult && adaptiveResult.orderingTrials > 0 && adaptiveResult.reusedPrefixGates === 256)
	assert.ok(adaptiveResult.liveNodes < adaptiveResult.diagramNodes)
	assert.equal(parseConfig({ strategies: { decisionDiagramProduct: { trialOrdering: true } } }).synthesis.decisionDiagramTrialOrdering, 'upfront')
	assert.equal(parseConfig({ strategies: { decisionDiagramProduct: { trialOrdering: false } } }).synthesis.decisionDiagramTrialOrdering, 'off')
	assert.throws(() => parseConfig({ strategies: { decisionDiagramProduct: { trialOrdering: 'random' } } }), /trialOrdering/)
	const pairedResult = await broadSearch(tables, lateMask, 53, createOptimizerCaches(), 5000, () => false, () => {})
	assert.equal(pairedResult.length, payload.length)
	assert.equal(createPolynomialEquivalenceChecker(payload, 53, 100000, 10000000)(pairedResult), true)
	// Vary the order and scratch allocation of each ladder to keep
	// allocating new nodes even though almost all output functions restore.
	const churn = Array.from({ length: 61 }, (_, i) => {
		const f = i % factors.length, b = i % borrowed.length
		return emitBorrowedProduct([...factors.slice(f), ...factors.slice(0, f)], [...borrowed.slice(b), ...borrowed.slice(0, b)], 38)
	}).flat()
	// An asymmetric predicate and its operand-swapped equivalent cancel.
	churn.push({ a: 5, b: 37, target: 38, gate_i: 2 }, { a: 37, b: 5, target: 38, gate_i: 4 })
	const retained = synthesizeDecisionDiagramProduct(churn, 64, () => false, 'adaptive', false)
	const compacted = synthesizeDecisionDiagramProduct(churn, 64, () => false)
	assert.ok(retained && compacted && compacted.collections > 0)
	assert.ok(compacted.retainedMemoEntries > 0)
	assert.ok(compacted.skippedMemoEntries > 0)
	assert.ok(compacted.peakNodes < retained.peakNodes)
	assert.equal(compacted.liveNodes, retained.liveNodes)
	assert.deepEqual(compacted.gates, retained.gates)
	assert.equal(createPolynomialEquivalenceChecker(churn, 39, 100000, 10000000)(compacted.gates), true)
	assert.equal(parseConfig({}).synthesis.decisionDiagramReclaim, true)
	assert.equal(parseConfig({ strategies: { decisionDiagramProduct: { reclaimNodes: false } } }).synthesis.decisionDiagramReclaim, false)
	const compactedBroad = await broadSearch(tables, churn, 39, createOptimizerCaches(), 5000, () => false, () => {})
	assert.deepEqual(compactedBroad, compacted.gates)
	config.search.localStrategyOrder = []
	config.search.broadStrategyOrder = []
	config.synthesis.decisionDiagramProduct = false

	Object.assign(config.synthesis, { factored: true, satSweeping: true, mixedBasis: true, blockCancellation: true, affine: true })
	config.search.dependencyCuts = true
	assert.deepEqual(broadStrategyOrder(), ['sat-sweeping', 'polynomial-shear-interpolation', 'basis-change-cancellation', 'block-cancellation', 'polynomial-region-search', 'factored-synthesis', 'dependency-cuts'])
	config.search.strategyAdaptive = true
	config.synthesis.broadSatCutsFirst = true
	let provenIndices: number[] | undefined
	const repeated = Array.from({ length: 1200 }, () => ({ a: 0, b: 0, target: 0, gate_i: 15 }))
	const cutResult = await broadSearch(tables, repeated, 1, createOptimizerCaches(), 5000, () => false, (_, activity) => {
		if (activity.cutPatch) provenIndices = activity.cutPatch.indices
	})
	assert.ok(provenIndices?.length && cutResult.length < repeated.length, 'cuts-first reports its exact cut')
	const bits = generateCombinations(1)
	assert.deepEqual(calculateAllOutputsArray(cutResult, bits), calculateAllOutputsArray(repeated, bits))

} finally {
	Object.assign(config, saved)
	await tables.close()
}
console.log('Broad toolkit: overlapping regions, global strategy order, local lookup batching and cancellation passed')

// A broad and local job must both start; queued old-baseline work is canceled.
const { WorkerPool } = await import('./threads.js')
const { WholeCircuitRestart, roundSearchResult } = await import('./round-search.js')
const fixture = new URL('data:text/javascript,' + encodeURIComponent(`
import {parentPort} from 'node:worker_threads';
parentPort.on('message', async ({gates,solver,stopSignal}) => {
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
