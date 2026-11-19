import assert from 'node:assert/strict'
import { mkdtemp, rm, rename, writeFile, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { execFile } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { LimitedMap } from './limitedMap.js'
import { SearchScheduler, createSearchArms, independentComponents } from './search.js'
import { createOptimizerCaches } from './processing.js'
import { AdaptiveConcurrency } from './concurrency.js'
import { createSharedTable, SharedTableReader, loadSharedTables, sharedTableBytes } from './shared-table.js'
import { initializeRainbowTables, openRainbowPortfolio } from './rainbow-portfolio.js'
import { databaseFilename } from './rainbowtable.js'
import { encodeGates, functionKey } from './semantic.js'
import { config, parseConfig } from './config.js'
import { WorkerPool } from './threads.js'
import { seededRandom } from './random.js'
import { getVars, calculateAllOutputsArray, generateCombinations } from './utils.js'

const fifo = new LimitedMap<number, string>(2)
fifo.set(1, 'a'); fifo.set(2, 'b'); fifo.set(1, 'updated')
assert.equal(fifo.size(), 2); assert.equal(fifo.get(2), 'b')
fifo.set(3, 'c'); assert.equal(fifo.get(1), undefined)
const lru = new LimitedMap<number, null | string>(2, 'lru')
lru.set(1, null); lru.set(2, 'b'); assert.equal(lru.get(1), null)
lru.set(3, 'c'); assert.equal(lru.has(2), false)
lru.set(1, 'updated'); assert.equal(lru.get(3), 'c'); assert.equal(lru.size(), 2)
assert.throws(() => new LimitedMap(1.5))
const scheduler = new SearchScheduler(5, 0.98, 7)
for (let i = 0; i < 2000; i++) { scheduler.record({ subset: i, slice: 2 }, 10, i % 3); assert.ok(scheduler.historySize <= 7) }
const arms = createSearchArms(16, 2, 199, 2, 199)
assert.deepEqual(arms, createSearchArms(16, 2, 199, 2, 199))
assert.ok(arms.every(arm => arm.slice <= arm.subset && arm.subset <= 199 && arm.subset >= 2))
const caches = createOptimizerCaches(), retained = caches.arms
caches.scheduler.record(retained[0], 10, 1)
assert.equal(caches.arms, retained)
const r1 = seededRandom(19), r2 = seededRandom(19)
assert.deepEqual(Array.from({ length: 30 }, () => r1()), Array.from({ length: 30 }, () => r2()))

const random = seededRandom(9527)
const n = (max: number) => Math.floor(random() * max)
for (let trial = 0; trial < 40; trial++) {
	const gates = Array.from({ length: 25 }, (_, i) => { const base = i % 2 ? 3 : 0; return { a: base + n(3), b: base + n(3), target: base + n(3), gate_i: n(16) } })
	const components = independentComponents(gates)
	assert.ok(components.length >= 2)
	for (let i = 0; i < components.length; i++) {
		const wires = new Set(components[i].flatMap(getVars))
		for (let j = i + 1; j < components.length; j++) assert.ok(components[j].flatMap(getVars).every(wire => !wires.has(wire)))
		assert.deepEqual(components[i].map(gate => gates.indexOf(gate)), components[i].map(gate => gates.indexOf(gate)).sort((a, b) => a - b))
	}
	const inputs = generateCombinations(6)
	assert.deepEqual(calculateAllOutputsArray(gates, inputs), calculateAllOutputsArray(components.flat(), inputs))
}
assert.deepEqual(independentComponents([]), [])

const sample = { concurrency: 4, elapsedMs: 1000, removed: 100, databaseMs: 0, workerMs: 4000, memoryPressure: 0.2 }
const controller = new AdaptiveConcurrency(8, 4, 2, 0.6, 0.05)
controller.observe(sample); controller.observe(sample); assert.equal(controller.limit(8), 5)
controller.observe({ ...sample, concurrency: 5, removed: 20 }); controller.observe({ ...sample, concurrency: 5, removed: 20 })
assert.equal(controller.limit(8), 4, 'unproductive trial returns to baseline')
controller.observe({ ...sample, memoryPressure: 1.2 }); assert.equal(controller.limit(8), 2)
const database = new AdaptiveConcurrency(8, 4, 2, 0.6, 0.05)
database.observe({ ...sample, databaseMs: 3500 }); database.observe({ ...sample, databaseMs: 3500 }); assert.equal(database.limit(8), 3)
const stalled = new AdaptiveConcurrency(8, 4, 2, 0.6, 0.05)
for (let i = 0; i < 20; i++) stalled.observe({ ...sample, removed: 0 })
assert.equal(stalled.limit(8), 4)
stalled.observe({ ...sample, concurrency: 2 }); assert.equal(stalled.limit(8), 4, 'small-circuit caps are not throughput trials')

const fixture = new URL('data:text/javascript,' + encodeURIComponent("import {parentPort} from 'node:worker_threads'; parentPort.on('message', msg=>{if(msg.gates)parentPort.postMessage({gates:msg.gates})})"))
const pool = new WorkerPool(3, fixture)
try {
	await Promise.all(Array.from({ length: 3 }, () => pool.run([], 1)))
	pool.setConcurrency(1); await pool.trimIdle()
	assert.deepEqual(await pool.run([], 1), [])
	pool.setConcurrency(3)
	assert.deepEqual(await Promise.all(Array.from({ length: 3 }, () => pool.run([], 1))), [[], [], []])
} finally { await pool.close() }

const not = { a: 0, b: 0, target: 0, gate_i: 15 }
const rows = [0, 128, 1, 129, 2, 130].map((value, i) => ({ ioIdentifier: Buffer.from([value]), replacerGates: encodeGates(i % 2 ? [] : [not]) }))
const shared = createSharedTable({ wires: 2, gates: 1 }, rows, 10000)!
const reader = new SharedTableReader(shared)
for (const [i, row] of rows.entries()) assert.deepEqual(reader.get(row.ioIdentifier.toString('hex')), i % 2 ? [] : [not])
assert.equal(reader.get('7f'), null); assert.equal(reader.get('wrong key'), null)
assert.equal(createSharedTable({ wires: 2, gates: 1 }, rows, 1), undefined)
assert.throws(() => new SharedTableReader({ ...shared, slots: 3 }))

const directory = await mkdtemp(join(tmpdir(), 'resource-search-'))
const saved = structuredClone(config)
try {
	config.files.databaseDirectory = directory
	config.files.dataDirectory = directory
	config.database.tables = [{ wires: 2, gates: 2 }]
	await initializeRainbowTables()
	const snapshots = await loadSharedTables()
	assert.equal(snapshots.length, 1)
	assert.ok(snapshots.reduce((sum, table) => sum + sharedTableBytes(table), 0) <= config.database.sharedTableBytes)
	const key = functionKey([not], 2)
	const sqlite = await openRainbowPortfolio()
	const windows = [{ wires: 1, mappedGates: [not, not, not] }]
	let expected
	try { expected = await sqlite.findReplacements(windows, new LimitedMap(100)) } finally { await sqlite.close() }
	const path = databaseFilename(2, 2)
	await rename(path, path + '.held')
	try {
		const memory = await openRainbowPortfolio(config.database.tables, snapshots)
		try { assert.deepEqual(await memory.findReplacements(windows, new LimitedMap(100)), expected) } finally { await memory.close() }
		const sharedFixture = new URL('data:text/javascript,' + encodeURIComponent(`import {parentPort,workerData} from 'node:worker_threads';import {SharedTableReader} from ${JSON.stringify(new URL('./shared-table.js', import.meta.url).href)};const index=new SharedTableReader(workerData.sharedTables[0]);parentPort.on('message',msg=>{if(msg.gates)parentPort.postMessage({gates:index.get(${JSON.stringify(key)})})});`))
		const sharedPool = new WorkerPool(1, sharedFixture, snapshots)
		try { assert.deepEqual(await sharedPool.run([], 2), [not]) } finally { await sharedPool.close() }
	} finally { await rename(path + '.held', path) }
	config.database.sharedTableMaximumRows = 1; assert.deepEqual(await loadSharedTables(), [])
	config.database.sharedTableMaximumRows = saved.database.sharedTableMaximumRows
	config.database.sharedTableBytes = 1; assert.deepEqual(await loadSharedTables(), [])
	config.database.sharedTableBytes = saved.database.sharedTableBytes
	config.database.sharedTables = false; assert.deepEqual(await loadSharedTables(), [])
	config.database.sharedTables = true
	config.benchmark = { ...config.benchmark, seconds: 0.1, repeats: 1, workerCounts: [1], maximumChecks: 2 }
	const settingsFile = join(directory, 'settings.json'), circuitFile = join(directory, 'circuit.json')
	await writeFile(settingsFile, JSON.stringify(config))
	await writeFile(circuitFile, JSON.stringify({ wire_count: 2, gate_count: 12, gates: Array.from({ length: 12 }, () => [1, 0, 0, 3]) }))
	const benchmark = fileURLToPath(new URL('./benchmark.js', import.meta.url))
	await new Promise<void>((resolve, reject) => execFile(process.execPath, [benchmark, circuitFile], { env: { ...process.env, OPTIMIZER_CONFIG: settingsFile }, timeout: 30000 }, (error, stdout, stderr) => error ? reject(new Error(`${error}\n${stdout}\n${stderr}`)) : resolve()))
	const report = JSON.parse(await readFile(join(directory, config.benchmark.outputName), 'utf8'))
	assert.equal(report.results.length, 2)
	assert.deepEqual(report.results.map((result: { variant: string }) => result.variant), ['reference', 'tuned'])
	assert.equal(report.results[0].seed, report.results[1].seed)
	assert.equal(report.results[0].sharedBytes, 0); assert.ok(report.results[1].sharedBytes > 0)
	assert.ok(report.results.every((result: { checks: number, controls: { adaptiveConcurrency: boolean } }) => result.checks <= config.benchmark.maximumChecks && result.controls.adaptiveConcurrency === false))
	assert.ok(report.results.every((result: { validation: string, databaseMs: number, workerMs: number, finalGates: number }) => result.validation === 'exhaustive' && result.finalGates <= 12 && result.databaseMs <= result.workerMs + 0.01))
} finally { Object.assign(config, saved); await rm(directory, { recursive: true, force: true }) }
for (const invalid of [{ search: { schedulerHistoryEntries: 0 } }, { cache: { lookupPolicy: 'unknown' } }, { workers: { initialConcurrency: 0 } }, { workers: { concurrencyDatabaseFraction: 1.1 } }, { workers: { concurrencyRateTolerance: 1 } }, { database: { sharedTableBytes: 0x80000000 } }, { benchmark: { workerCounts: [] } }, { benchmark: { workerCounts: [1, 1] } }, { benchmark: { seconds: 0 } }, { benchmark: { outputName: '../input.json' } }]) assert.throws(() => parseConfig(invalid))
console.log('Bounded scheduler/cache behavior, shared indexes, component equivalence, concurrency control and benchmark regressions passed')
