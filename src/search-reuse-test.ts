import assert from 'node:assert/strict'
import sqlite3 from 'sqlite3'
import { LookupFunction } from './lookup-function.js'
import { SlidingWindowWires } from './window-wires.js'
import { NeighborhoodQueue, SearchScheduler } from './search.js'
import { TemplateLibrary } from './templates.js'
import { WorkerPool } from './threads.js'
import { RainbowPortfolio } from './rainbow-portfolio.js'
import { LimitedMap } from './limitedMap.js'
import { runSQL } from './sql.js'
import { Gate } from './types.js'
import { calculateAllOutputsArray, generateCombinations, ioHash, mapVariablesToIndexes, findConvexSubsets } from './utils.js'
import { config, parseConfig } from './config.js'

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
	const { optimizeSubset } = await import('./processing.js')
	const { templates } = await import('./strategies.js')
	const cn = { a: 1, b: 0, target: 0, gate_i: 3 }, invertControl = { a: 0, b: 0, target: 1, gate_i: 15 }
	const before = [cn, invertControl, cn], after = [invertControl, { ...invertControl, target: 0 }]
	const lookup = new LimitedMap<string, Gate[] | null>(100), processed = new LimitedMap<string, boolean>(100), tested = new LimitedMap<string, boolean>(100)
	const activity = { passes: 0, subsets: 0, checks: 0, improvements: 0, stage: 'searching' as const }
	assert.deepEqual(await optimizeSubset(portfolio, before, lookup, processed, 3, 3, 'heavy', () => false, activity, () => {}, tested, 'rainbow', undefined, { deadline: -Infinity }), before)
	// Isolate template/cache invalidation from the independently tested synthesis solvers.
	const previousChecks = activity.checks
	assert.equal(templates.learn(before, after, false), true)
	const reduced = await optimizeSubset(portfolio, before, lookup, processed, 3, 3, 'heavy', () => false, activity, () => {}, tested, 'rainbow', undefined, { deadline: -Infinity })
	assert.ok(activity.checks > previousChecks, 'new rules invalidate stale subset failures')
	assert.equal(reduced.length, 2)
	assert.deepEqual(calculateAllOutputsArray(reduced, generateCombinations(2)), calculateAllOutputsArray(before, generateCombinations(2)))
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

const n0 = { a: 0, b: 0, target: 0, gate_i: 15 }, n1 = { ...n0, target: 1 }
const rule = { before: [n0, n1, n0], after: [n1] }
const source = new TemplateLibrary(4, 3), receiver = new TemplateLibrary(4, 3)
assert.equal(source.learn(rule.before, rule.after), true)
const batch = source.drainShared(1)
assert.equal(batch.length, 1)
assert.equal(receiver.importShared(batch, 1), 1)
assert.equal(receiver.version, 1)
assert.deepEqual(receiver.rewrite(rule.before), rule.after)
assert.deepEqual(receiver.drainShared(10), [], 'imported rules are not echoed')
assert.equal(receiver.importShared(batch, 1), 0)
assert.equal(receiver.version, 1, 'duplicates do not invalidate failure caches')
assert.equal(receiver.importShared([{ before: [n0], after: [] }, null, { before: [{ ...n0, gate_i: 99 }], after: [] }], 3), 0)
assert.equal(receiver.importShared([{ before: rule.before, after: [n0] }], 1), 0)
batch[0].after[0].target = 2
assert.deepEqual(source.exportShared(1), [rule], 'exported rules cannot mutate stored rules')

// Existing peers receive broadcasts; workers created later receive the retained bank.
const libraryUrl = new URL('./templates.js', import.meta.url).href
const fixture = new URL('data:text/javascript,' + encodeURIComponent(`
import {parentPort} from 'node:worker_threads';
import {TemplateLibrary} from ${JSON.stringify(libraryUrl)};
const library = new TemplateLibrary(64,3,8), rule = ${JSON.stringify(rule)};
let pending, timer;
function finish() {
 if(!pending) return;
 const result=library.rewrite(pending.gates);
 if(result.length===pending.gates.length) return;
 clearTimeout(timer); pending=undefined; parentPort.postMessage({gates:result});
}
parentPort.on('message', msg => {
 if(msg.sharedTemplates) {library.importShared(msg.sharedTemplates,16);finish();return;}
 if(msg.gates.length===1) {
  library.learn(rule.before,rule.after);
  parentPort.postMessage({sharedTemplates:[rule,{before:[rule.before[0]],after:[]}]});
  parentPort.postMessage({gates:msg.gates}); return;
 }
 pending=msg; timer=setTimeout(()=>parentPort.postMessage({error:'shared template not delivered'}),5000);finish();
});`))
const pool = new WorkerPool(3, fixture)
const sharingEnabled = config.workers.shareTemplates
try {
	config.workers.shareTemplates = true
	const [, result] = await Promise.all([pool.run([n0], 3), pool.run(rule.before, 3)])
	assert.deepEqual(result, rule.after)
	const later = await Promise.all(Array.from({ length: 3 }, () => pool.run(rule.before, 3)))
	assert.deepEqual(later, [rule.after, rule.after, rule.after])
} finally { await pool.close(); config.workers.shareTemplates = sharingEnabled }
for (const [section, key, invalid] of [['search', 'schedulerDecay', 0], ['search', 'schedulerDecay', 1.1], ['search', 'localSearchSeeds', 0], ['search', 'localSearchRadius', -1], ['search', 'localSearchBroadEvery', 0], ['workers', 'sharedTemplateEntries', 0], ['workers', 'sharedTemplateBatch', 0], ['workers', 'sharedTemplateSeconds', 0]] as const) assert.throws(() => parseConfig({ [section]: { [key]: invalid } }))
console.log('Packed lookup reuse, sliding wires, focused search, scheduler decay and verified worker sharing regressions passed')
