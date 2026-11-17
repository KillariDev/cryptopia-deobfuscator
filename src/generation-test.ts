import assert from 'node:assert/strict'
import { generationLookupSchema, packState, unpackState } from './generation-storage.js'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import sqlite3 from 'sqlite3'
import { Gate } from './types.js'
import { applyState, circuitState, decodeGates } from './semantic.js'
import { getVars, ioHash, isReplacementSimpler } from './utils.js'
import { ExpansionKernel, ExpansionResult, ExpansionTask, packParents, stateIdentifier } from './generation-expansion.js'
import { expandBatch } from './generation-pipeline.js'
import { GenerationPool } from './generation-pool.js'
import { generateOnDisk } from './disk-generation.js'
import { generateAllGates, configureGenerationDatabase } from './rainbowtable.js'
import { allSQL, runSQL } from './sql.js'
import { overallGenerationWork, GenerationEstimator, formatGenerationProgress, GenerationProfile } from './generation-progress.js'
import { config, parseConfig } from './config.js'

let seed = 1927
const random = (max: number) => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed % max }
const unpack = (result: ExpansionResult, bytes: number) => {
	const values = new Map<string, { parent: number, gate: number, mask: number, reads: number }>(), view = new DataView(result.candidates)
	assert.equal(result.candidates.byteLength, result.count * (bytes + 16))
	for (let i = 0; i < result.count; i++) {
		const offset = i * (bytes + 16), state = Buffer.from(result.candidates, offset, bytes)
		const parent = view.getUint32(offset + bytes, true), gate = view.getUint32(offset + bytes + 4, true)
		const mask = view.getUint32(offset + bytes + 8, true), reads = view.getUint32(offset + bytes + 12, true)
		values.set(`${state.toString('hex')}:${mask}`, { parent, gate, mask, reads })
	}
	return values
}
for (let wires = 1; wires <= 8; wires++) {
	// Include all control functions and aliased targets, plus duplicate candidates.
	const gates: Gate[] = Array.from({ length: 64 }, (_, i) => ({ a: random(wires), b: random(wires), target: random(wires), gate_i: i % 16 }))
	const parents = Array.from({ length: 5 }, () => ({ state: circuitState(gates.slice(0, random(20)), wires), mask: random(1 << wires), reads: random(50) }))
	for (const parent of parents) { assert.deepEqual(unpackState(packState(parent.state, wires), wires), parent.state); assert.equal(packState(parent.state, wires).length, Math.ceil(2 ** wires * wires / 8)) }
	for (const parent of parents) assert.equal(stateIdentifier(parent.state, wires), ioHash([...parent.state].flatMap(word => Array.from({ length: wires }, (_, wire) => !!(word & 1 << wire)))))
	const expected = new Map<string, { parent: number, gate: number, mask: number, reads: number }>()
	for (const [parent, entry] of parents.entries()) for (const [gate, value] of gates.entries()) {
		const variables = getVars(value), mask = entry.mask | variables.reduce((mask, wire) => mask | 1 << wire, 0), reads = entry.reads + variables.length
		const key = `${Buffer.from(applyState(entry.state, value)).toString('hex')}:${mask}`
		if (!expected.has(key) || reads < expected.get(key)!.reads) expected.set(key, { parent, gate, mask, reads })
	}
	const kernel = new ExpansionKernel(wires, gates)
	const result = kernel.expand({ parents: packParents(parents, kernel.stateBytes), gateStart: 0, gateEnd: gates.length })
	assert.deepEqual(unpack(result, kernel.stateBytes), expected)
	assert.equal(result.attempts, parents.length * gates.length)
	assert.ok(result.count <= result.attempts)
}
assert.throws(() => packParents([{ state: new Uint8Array(2), mask: 0, reads: -1 }], 2))
assert.throws(() => packParents([{ state: new Uint8Array(2), mask: 0, reads: 0x100000000 }], 2))

const gates = [...generateAllGates(2)], kernel = new ExpansionKernel(2, gates)
const parents = Array.from({ length: 6 }, (_, i) => ({ state: circuitState(gates.slice(0, i), 2), mask: 0, reads: i }))
const pool = new GenerationPool(2, 2, gates)
try {
	const task = { parents: packParents(parents, 4), gateStart: 0, gateEnd: gates.length }
	const expected = kernel.expand(task), result = pool.run(task)
	assert.equal(task.parents.byteLength, 0, 'worker input buffer is transferred')
	assert.deepEqual(unpack(await result, 4), unpack(expected, 4))
	let peak = 0, attempts = 0
	for await (const chunk of expandBatch(parents, gates.length, kernel, pool, { stageRows: 3, workers: 2, queueBatches: 2, minimumWork: 1 }, pending => { peak = Math.max(peak, pending) })) {
		assert.ok(chunk.result.attempts <= 3, 'even a catalog larger than stageRows is split')
		attempts += chunk.result.attempts
	}
	assert.equal(attempts, parents.length * gates.length)
	assert.ok(peak <= 4)
} finally { await pool.close() }

// Force later tasks to complete before the first; submission order must survive.
const completed: number[] = []
class ReorderedPool extends GenerationPool {
	private first?: () => void
	private index = 0
	override run(task: ExpansionTask): Promise<ExpansionResult> {
		const id = this.index++, result = kernel.expand(task)
		if (id === 0) return new Promise(resolve => { this.first = () => { completed.push(id); resolve(result) } })
		completed.push(id)
		const first = this.first; this.first = undefined
		queueMicrotask(() => first?.())
		return Promise.resolve(result)
	}
}
const reordered = new ReorderedPool(2, 2, gates)
try {
	const order: number[] = []
	for await (const chunk of expandBatch(parents, gates.length, kernel, reordered, { stageRows: gates.length, workers: 2, queueBatches: 1, minimumWork: 1 })) order.push(chunk.parents[0].reads)
	assert.deepEqual(order, parents.map(parent => parent.reads))
	assert.equal(completed[0], 1)
} finally { await reordered.close() }

const crashed = new GenerationPool(2, 2, gates, new URL('data:text/javascript,process.exit(7)'))
try {
	const results = await Promise.allSettled(Array.from({ length: 5 }, () => crashed.run({ parents: packParents(parents, 4), gateStart: 0, gateEnd: gates.length })))
	assert.ok(results.every(result => result.status === 'rejected'))
} finally { await crashed.close() }
const invalid = new GenerationPool(1, 2, gates)
try {
	await assert.rejects(invalid.run({ parents: packParents(parents, 4), gateStart: 0, gateEnd: gates.length + 1 }), /Invalid expansion task/)
} finally { await invalid.close() }

const directory = await mkdtemp(join(tmpdir(), 'rainbow-parallel-test-'))
const open = async (name: string) => {
	const db = new sqlite3.Database(join(directory, name))
	await runSQL(db, generationLookupSchema)
	return db
}
const close = (db: sqlite3.Database) => new Promise<void>((resolve, reject) => db.close(error => error ? reject(error) : resolve()))
type Row = { ioIdentifier: Buffer, replacerGates: Buffer, gateCount: number, wireCount: number, readCount: number }
const rows = (db: sqlite3.Database) => allSQL<Row>(db, 'SELECT * FROM InputOutputReplacers ORDER BY ioIdentifier')
const options = { readRows: 5, stageRows: 7, parameterLimit: 40, stateLimit: 0, keepState: false, workers: 2, queueBatches: 2, minimumWork: 1 }
const best = new Map<string, Gate[]>()
for (let depth = 0, layer: Gate[][] = [[]]; depth <= 3; depth++) {
	for (const sequence of layer) {
		const id = stateIdentifier(circuitState(sequence, 2), 2), previous = best.get(id)
		if (!previous || isReplacementSimpler(sequence, previous)) best.set(id, sequence)
	}
	layer = layer.flatMap(sequence => gates.map(gate => [...sequence, gate]))
}
const check = async (db: sqlite3.Database) => {
	const actual = await rows(db)
	assert.equal(actual.length, best.size)
	for (const row of actual) {
		const id = row.ioIdentifier.toString('hex'), sequence = decodeGates(row.replacerGates)
		assert.equal(stateIdentifier(circuitState(sequence, 2), 2), id)
		assert.equal(isReplacementSimpler(best.get(id)!, sequence), false)
		const variables = sequence.flatMap(getVars)
		assert.deepEqual([row.gateCount, row.wireCount, row.readCount], [sequence.length, new Set(variables).size, variables.length])
	}
	assert.equal((await allSQL<{ functions: number }>(db, 'SELECT functions FROM BuildMeta'))[0].functions, actual.length)
	return actual
}
try {
	let reference: Row[] | undefined
	for (const workers of [1, 2, 4]) {
		const db = await open(`workers-${workers}.db`)
		try {
			let profile: GenerationProfile | undefined
			await generateOnDisk(db, 2, 3, gates, { ...options, workers, onProfile: value => { profile = value } })
			const actual = await check(db)
			if (reference) assert.deepEqual(actual, reference)
			else reference = actual
			assert.ok(profile && profile.candidates >= profile.emitted && profile.peakPending <= workers * options.queueBatches)
			assert.equal(profile!.workersUsed, workers === 1 ? 0 : workers)
		} finally { await close(db) }
	}
	// Stop and restart with a different worker count and task size.
	let db = await open('resume.db')
	try {
		let polls = 0
		assert.equal(await generateOnDisk(db, 2, 3, gates, options, undefined, () => ++polls > 3), false)
	} finally { await close(db) }
	db = await open('resume.db')
	try {
		await generateOnDisk(db, 2, 3, gates, { ...options, workers: 1, stageRows: 3 })
		await check(db)
	} finally { await close(db) }
	// A writer error after parallel expansion leaves no half-committed frontier/results.
	db = await open('rollback.db')
	try {
		await assert.rejects(generateOnDisk(db, 2, 3, gates, { ...options, beforeCommit: async () => { throw new Error('writer failed') } }), /writer failed/)
		assert.equal((await rows(db)).length, 0)
		assert.equal((await allSQL<{ processed: number }>(db, 'SELECT processed FROM BuildMeta'))[0].processed, 0)
		await generateOnDisk(db, 2, 3, gates, options)
		await check(db)
	} finally { await close(db) }
	// A staging write can fail while later CPU tasks are still queued/running.
	db = await open('staging-error.db')
	try {
		const nativeRun = db.run.bind(db)
		let failed = false
		db.run = ((query: string, ...args: unknown[]) => {
			const values = args[0] as unknown[]
			if (!failed && query.startsWith('INSERT INTO BuildCandidates') && Array.isArray(values) && Buffer.isBuffer(values[3]) && values[3].length > 0) {
				failed = true
				const callback = args[args.length - 1] as Function
				queueMicrotask(() => callback(new Error('staging write failed')))
				return db
			}
			return (nativeRun as Function)(query, ...args)
		}) as typeof db.run
		await assert.rejects(generateOnDisk(db, 2, 3, gates, { ...options, stageRows: 1 }), /staging write failed/)
		assert.equal((await rows(db)).length, 0)
		assert.equal((await allSQL<{ processed: number }>(db, 'SELECT processed FROM BuildMeta'))[0].processed, 0)
		await generateOnDisk(db, 2, 3, gates, options)
		await check(db)
	} finally { await close(db) }
	// State-limit rollback after expansion permits a clean retry.
	db = await open('limit.db')
	try {
		await assert.rejects(generateOnDisk(db, 2, 3, gates, { ...options, stateLimit: 1 }), /state limit/)
		await generateOnDisk(db, 2, 3, gates, options)
		await check(db)
	} finally { await close(db) }
	// Interrupt inside the last expansion layer: final output and progress roll back together.
	db = await open('final-resume.db')
	try {
		let failed = false, finalBatches = 0
		await assert.rejects(generateOnDisk(db, 2, 3, gates, { ...options, keepState: true, beforeCommit: async () => {
			const depth = (await allSQL<{ depth: number }>(db, 'SELECT depth FROM BuildMeta'))[0].depth
			assert.equal((await allSQL<{ count: number }>(db, 'SELECT count(*) AS count FROM BuildFrontier WHERE depth=3'))[0].count, 0, 'last-depth candidates never enter the frontier')
			if (depth === 2 && ++finalBatches === 2) { failed = true; throw new Error('final-layer interruption') }
		} }), /final-layer interruption/)
		assert.ok(failed)
		const checkpoint = (await allSQL<{ processed: number }>(db, 'SELECT processed FROM BuildMeta'))[0].processed
		assert.equal(checkpoint, options.readRows)
		assert.equal((await allSQL<{ processed: number }>(db, 'SELECT processed FROM BuildLayers WHERE depth=2'))[0].processed, checkpoint)
		const keySize = (await allSQL<{ bytes: number }>(db, 'SELECT length(state) AS bytes FROM BuildSeen LIMIT 1'))[0].bytes
		assert.equal(keySize, 1, 'two-wire generation keys are packed')
	} finally { await close(db) }
	db = await open('final-resume.db')
	try { await generateOnDisk(db, 2, 3, gates, options); await check(db) }
	finally { await close(db) }

	// Four-variable packed keys and non-bijective controls agree with brute force.
	const mixed: Gate[] = [
		{ a: 0, b: 1, target: 2, gate_i: 1 }, { a: 0, b: 0, target: 0, gate_i: 3 },
		{ a: 2, b: 3, target: 1, gate_i: 7 }, { a: 3, b: 3, target: 3, gate_i: 15 },
		{ a: 1, b: 2, target: 0, gate_i: 6 }, { a: 0, b: 0, target: 1, gate_i: 3 },
	]
	const mixedBest = new Map<string, Gate[]>()
	for (let depth = 0, layer: Gate[][] = [[]]; depth <= 4; depth++) {
		for (const sequence of layer) {
			const key = stateIdentifier(circuitState(sequence, 4), 4), prior = mixedBest.get(key)
			if (!prior || isReplacementSimpler(sequence, prior)) mixedBest.set(key, sequence)
		}
		if (depth < 4) layer = layer.flatMap(sequence => mixed.map(gate => [...sequence, gate]))
	}
	db = await open('mixed-four-wire.db')
	try {
		await generateOnDisk(db, 4, 4, mixed, { ...options, keepState: true })
		const actual = await rows(db)
		assert.equal(actual.length, mixedBest.size)
		for (const row of actual) {
			const sequence = decodeGates(row.replacerGates), key = row.ioIdentifier.toString('hex')
			assert.equal(stateIdentifier(circuitState(sequence, 4), 4), key)
			assert.equal(isReplacementSimpler(mixedBest.get(key)!, sequence), false)
		}
		assert.equal((await allSQL<{ bytes: number }>(db, 'SELECT length(state) AS bytes FROM BuildSeen LIMIT 1'))[0].bytes, 8)
		assert.equal((await allSQL<{ count: number }>(db, 'SELECT count(*) AS count FROM BuildFrontier WHERE depth=4'))[0].count, 0)
	} finally { await close(db) }

	// An incompatible checkpoint is rejected without changing its stored metadata.
	db = await open('incompatible.db')
	try {
		await generateOnDisk(db, 2, 3, gates, options, undefined, () => true)
		await runSQL(db, "UPDATE BuildMeta SET signature='old-unpacked-build'")
		const before = await allSQL(db, 'SELECT * FROM BuildMeta')
		await assert.rejects(generateOnDisk(db, 2, 3, gates, options), /Incompatible generation checkpoint/)
		assert.deepEqual(await allSQL(db, 'SELECT * FROM BuildMeta'), before)
	} finally { await close(db) }

	// SQLite settings are applied explicitly, including separate temporary-page cache.
	db = await open('pragmas.db')
	const savedConfig = structuredClone(config)
	try {
		config.database.generationCacheMegabytes = 8
		for (const mode of ['wal', 'delete'] as const) {
			config.database.generationJournalMode = mode
			config.database.generationTempStore = mode === 'wal' ? 'file' : 'memory'
			config.database.generationSynchronous = mode === 'wal' ? 'full' : 'normal'
			await configureGenerationDatabase(db)
			assert.equal((await allSQL<{ journal_mode: string }>(db, 'PRAGMA journal_mode'))[0].journal_mode, mode)
			assert.equal((await allSQL<{ cache_size: number }>(db, 'PRAGMA cache_size'))[0].cache_size, -8192)
			assert.equal((await allSQL<{ synchronous: number }>(db, 'PRAGMA synchronous'))[0].synchronous, mode === 'wal' ? 2 : 1)
			assert.equal((await allSQL<{ temp_store: number }>(db, 'PRAGMA temp_store'))[0].temp_store, mode === 'wal' ? 1 : 2)
		}
	} finally { Object.assign(config, savedConfig); await close(db) }

} finally { await rm(directory, { recursive: true, force: true }) }
for (const key of ['generationWorkers', 'generationQueueBatches', 'generationMinimumWork']) for (const value of [0, -1, 1.5, '4']) assert.throws(() => parseConfig({ database: { [key]: value } }))
console.log('Packed expansion, bounded parallel generation, deterministic results, failure cleanup and resume regressions passed')

const projected = overallGenerationWork([{ depth: 0, total: 1, processed: 1 }, { depth: 1, total: 10, processed: 5 }], 4)
assert.deepEqual(projected, { overallDone: 6, overallTotal: 1111, overallEstimated: true })
const known = overallGenerationWork([{ depth: 0, total: 1, processed: 1 }, { depth: 1, total: 10, processed: 10 }, { depth: 2, total: 80, processed: 20 }], 3)
assert.deepEqual(known, { overallDone: 31, overallTotal: 91, overallEstimated: false })
const eta = new GenerationEstimator(3, 1, 1)
eta.update({ depth: 2, processed: 10, total: 80, states: 1 }, 0)
eta.update({ depth: 2, processed: 20, total: 80, states: 1 }, 1000)
assert.equal(eta.overallEta({ depth: 2, processed: 20, total: 80, states: 1, ...known }), '~6s')
assert.equal(formatGenerationProgress({ depth: 2, processed: 20, total: 80, states: 1, ...known }, 1000, '~6s'), 'Rainbow generation: 34.06% complete | ETA ~6s')
assert.equal(overallGenerationWork([{ depth: 0, total: 1, processed: 1 }], 1, true).overallTotal, 1)
for (const key of ['generationReadRows', 'generationCacheMegabytes']) for (const value of [0, -1, 1.5, '4']) assert.throws(() => parseConfig({ database: { [key]: value } }))
for (const key of ['generationTempStore', 'generationJournalMode', 'generationSynchronous']) assert.throws(() => parseConfig({ database: { [key]: 'invalid' } }))
console.log('Direct final merge, packed storage, atomic resume, SQLite tuning and overall progress checks passed')

const stalled = new GenerationEstimator(2, 1, 1)
for (let i = 0; i < 3; i++) stalled.update({ depth: 2, processed: 20, total: 80, states: 1 }, i * 1000)
assert.match(stalled.overallEta({ depth: 2, processed: 20, total: 80, states: 1, ...known }), /waiting for progress/)

const finishedWork = { depth: 2, processed: 80, total: 80, states: 1, overallDone: 91, overallTotal: 91, overallEstimated: false }
assert.equal(eta.overallEta(finishedWork), 'finishing')
assert.match(formatGenerationProgress(finishedWork, 1000, 'finishing'), /99.99% complete/)
assert.equal(eta.overallEta({ ...finishedWork, complete: true }), '0s')
assert.match(formatGenerationProgress({ ...finishedWork, complete: true }, 1000, '0s'), /100.00% complete/)
