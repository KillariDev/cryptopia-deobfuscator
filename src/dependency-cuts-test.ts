import { opaqueRainbow } from './opaque-rainbow.js'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DependencyCutIndex, CutCancelled, searchDependencyCuts } from './dependency-cuts.js'
import { config } from './config.js'
import { createRainbowTable } from './rainbowtable.js'
import { RainbowPortfolio } from './rainbow-portfolio.js'
import { RoundStrategyPicker } from './strategy-picker.js'
import { createOptimizerCaches, massOptimizeStep, SubsetPreparation } from './processing.js'
import { analyzeFactored, synthesizeFactored } from './factored.js'
import { sweepFactored, SweepStats } from './sat-sweeping-core.js'
import { strategySnapshot, resetStrategyStats } from './strategy-stats.js'
import { evalCircuit, generateCombinations } from './utils.js'
import { seededRandom } from './random.js'
import { Gate } from './types.js'

const equivalent = (before: Gate[], after: Gate[], wires: number) => {
 for (const input of generateCombinations(wires)) assert.deepEqual(evalCircuit(before, input), evalCircuit(after, input))
}
const gate = (a: number, b: number, target: number, gate_i: number): Gate => ({ a, b, target, gate_i })
const cn = gate(0, 0, 1, 3)
const sparse = [cn, ...Array.from({ length: 10000 }, () => gate(3, 4, 5, 1)), cn]
const sparseIndex = new DependencyCutIndex(sparse), sparseCut = sparseIndex.select(10001, 2)!
assert.deepEqual(sparseCut.indices, [0, 10001])
equivalent(sparse, sparseIndex.patch(sparseCut, []), 6)
assert.throws(() => sparseIndex.patch({ ...sparseCut, gates: [] }, []), /Stale/)
assert.throws(() => sparseIndex.patch(sparseCut, [gate(0, 0, 42, 15)]), /boundary wire/)
const war = new DependencyCutIndex([cn, gate(0, 0, 0, 15), cn])
assert.equal(war.cut([0, 2]), undefined, 'cannot cross an overwrite of a consumed control')
const fork = new DependencyCutIndex([cn, gate(1, 1, 2, 3), cn])
assert.equal(fork.cut([0, 2]), undefined, 'cannot hide an intermediate value read by an external output')
assert.throws(() => new DependencyCutIndex([cn], () => true), CutCancelled)
assert.equal(await searchDependencyCuts([cn, cn], () => true, async () => []), undefined)
assert.deepEqual([...new DependencyCutIndex([cn]).regions()], [])

// Exhaustively check the movement theorem, including non-involutive aliases
// and all Boolean gate functions. Replacement leaves every region output intact.
const random = seededRandom(20261124), pick = (n: number) => Math.floor(random() * n)
for (let trial = 0; trial < 40; trial++) {
 const input = Array.from({ length: 12 }, () => gate(pick(4), pick(4), pick(4), pick(16)))
 const index = new DependencyCutIndex(input)
 for (let seed = 0; seed < input.length; seed++) for (const size of [2, 4, 8]) {
  const cut = index.select(seed, size)!
  equivalent(input, index.patch(cut, cut.gates), 4)
 }
}

const t = gate(0, 1, 2, 1), cx = gate(3, 0, 4, 3)
const identity = [t, cx, gate(2, 4, 5, 1), cx, gate(2, 3, 5, 1), gate(2, 4, 5, 1), t]
const cubic = [gate(6, 7, 8, 1), gate(8, 9, 10, 1), gate(6, 7, 8, 1)]
const mixed: Gate[] = [], selected: number[] = []
for (let i = 0; i < identity.length; i++) { selected.push(mixed.length); mixed.push(identity[i]); if (i % 2 === 0 && i / 2 < cubic.length) mixed.push(cubic[i / 2]) }
const options = { maximumWires: 64, maximumNodes: 200000, maximumEdges: 16000000, stopped: () => false }
assert.equal(synthesizeFactored(mixed, options), undefined)
const wholeStats: SweepStats = { queries: 0, merges: 0, counterexamples: 0 }
const partial = await sweepFactored(mixed, options, performance.now() + 30000, wholeStats)
assert.ok(partial && partial.length < mixed.length)
equivalent(mixed, partial, 11)
assert.ok(wholeStats.merges > 0 && wholeStats.rebuilds! > 0, 'keep proved writes even when the remaining output is cubic')
const noisy = [...mixed, ...Array.from({ length: 10 }, (_, i) => gate(11 + i * 3, 12 + i * 3, 13 + i * 3, 1))]
const coneStats: SweepStats = { queries: 0, merges: 0, counterexamples: 0 }
assert.ok((await sweepFactored(noisy, options, performance.now() + 30000, coneStats))!.length < noisy.length)
assert.ok(coneStats.merges > 0 && coneStats.coneNodes! < analyzeFactored(noisy, options).graph.products.length, 'SAT only defines the queried cones, excluding independent nonlinear outputs')
const index = new DependencyCutIndex(mixed), cut = index.cut(selected)!
const solved = await sweepFactored(cut.gates, options, performance.now() + 30000)
assert.deepEqual(solved, [])
equivalent(mixed, index.patch(cut, solved!), 11)

// Exercise the production adaptive dispatch, not just extraction helpers.
const saved = structuredClone(config), directory = await mkdtemp(join(tmpdir(), 'dependency-cut-test-'))
let tables: RainbowPortfolio | undefined
try {
 config.files.databaseDirectory = directory; config.files.dataDirectory = directory
 config.logging.verbose = false; config.logging.generationDiagnostics = false
 tables = new RainbowPortfolio([{ wires: 3, gates: 1, db: await createRainbowTable(3, 1) }])
 const scratch = [gate(0,0,3,3), t, gate(0,0,3,3)]
 const opaque = await opaqueRainbow(scratch, tables, new (await import('./limitedMap.js')).LimitedMap(100), () => false)
 assert.equal(opaque?.length, 1, 'lookup uses three live values despite a fourth restored workspace wire')
 equivalent(scratch, opaque!, 4)
 const caches = createOptimizerCaches()
 const picker = new RoundStrategyPicker(['dependency-cuts'])
 config.search.strategyAdaptive = true
 config.search.dependencyCuts = true
 config.search.variableElimination = false
 Object.assign(config.synthesis, { templates: false, affine: false, quadratic: false, factored: false, blockCancellation: false, satSweeping: false, mixedBasis: false, forwardSemanticSearch: false, smt: false, meetInMiddle: false, equalitySaturation: false })
 resetStrategyStats()
 const rewritten = await massOptimizeStep(tables, caches.ioIdentifierCache, caches.processedGatesCache, sparse, sparse.length, false, false, true, new SubsetPreparation(sparse), { deadline: performance.now() + 10000, broad: true, minimumBroadGates: sparse.length }, picker)
 assert.equal(rewritten.gates.length, sparse.length - 2)
 equivalent(sparse, rewritten.gates, 6)
 assert.ok(strategySnapshot().some(stat => stat.strategy === 'rainbow' && stat.gatesRemoved === 2), 'reuse rainbow lookup on distant live values')
 config.synthesis.satSweeping = true
 resetStrategyStats()
	let patched = mixed
	for (let round = 0; round < 4 && patched.length > 3; round++) {
	 const next = await massOptimizeStep(tables, caches.ioIdentifierCache, caches.processedGatesCache, patched, patched.length, false, false, true, new SubsetPreparation(patched), { deadline: performance.now() + 30000, broad: true }, picker)
	 assert.ok(next.changed)
	 patched = next.gates
	 equivalent(mixed, patched, 11)
	}
	assert.equal(patched.length, 3, 'regional SAT patches retain an unsupported cubic output elsewhere')
	assert.ok(strategySnapshot().some(stat => stat.strategy === 'sat-sweeping' && stat.gatesRemoved > 0))
} finally { await tables?.close(); Object.assign(config, saved); await rm(directory, { recursive: true, force: true }) }
console.log('Global dependency cuts: read/write boundaries, distant rainbow rewrites, mixed cubic SAT patches, iterative sweeping, cancellation and exhaustive movement checks passed')
