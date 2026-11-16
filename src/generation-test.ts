import assert from 'node:assert/strict'
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
import { generateAllGates, storeReplacers } from './rainbowtable.js'
import { allSQL, runSQL } from './sql.js'
import { GenerationProfile } from './generation-progress.js'
import { parseConfig } from './config.js'

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
	await runSQL(db, 'CREATE TABLE IF NOT EXISTS InputOutputReplacers(ioIdentifier BLOB PRIMARY KEY,replacerGates BLOB NOT NULL) WITHOUT ROWID')
	return db
}
const close = (db: sqlite3.Database) => new Promise<void>((resolve, reject) => db.close(error => error ? reject(error) : resolve()))
type Row = { ioIdentifier: Buffer, replacerGates: Buffer }
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
	}
	return actual
}
try {
	let reference: Row[] | undefined
	for (const workers of [1, 2, 4]) {
		const db = await open(`workers-${workers}.db`)
		try {
			let profile: GenerationProfile | undefined
			await generateOnDisk(db, 2, 3, gates, { ...options, workers, onProfile: value => { profile = value } }, entries => storeReplacers(db, entries, true))
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
		assert.equal(await generateOnDisk(db, 2, 3, gates, options, entries => storeReplacers(db, entries, true), undefined, () => ++polls > 3), false)
	} finally { await close(db) }
	db = await open('resume.db')
	try {
		await generateOnDisk(db, 2, 3, gates, { ...options, workers: 1, stageRows: 3 }, entries => storeReplacers(db, entries, true))
		await check(db)
	} finally { await close(db) }
	// A writer error after parallel expansion leaves no half-committed frontier/results.
	db = await open('rollback.db')
	try {
		await assert.rejects(generateOnDisk(db, 2, 3, gates, options, async entries => { await storeReplacers(db, entries, true); throw new Error('writer failed') }), /writer failed/)
		assert.equal((await rows(db)).length, 0)
		assert.equal((await allSQL<{ processed: number }>(db, 'SELECT processed FROM BuildMeta'))[0].processed, 0)
		await generateOnDisk(db, 2, 3, gates, options, entries => storeReplacers(db, entries, true))
		await check(db)
	} finally { await close(db) }
	// A staging write can fail while later CPU tasks are still queued/running.
	db = await open('staging-error.db')
	try {
		const nativeRun = db.run.bind(db)
		let failed = false
		db.run = ((query: string, ...args: unknown[]) => {
			if (!failed && query.startsWith('INSERT INTO BuildCandidates')) {
				failed = true
				const callback = args[args.length - 1] as Function
				queueMicrotask(() => callback(new Error('staging write failed')))
				return db
			}
			return (nativeRun as Function)(query, ...args)
		}) as typeof db.run
		await assert.rejects(generateOnDisk(db, 2, 3, gates, { ...options, stageRows: 1 }, entries => storeReplacers(db, entries, true)), /staging write failed/)
		assert.equal((await rows(db)).length, 0)
		assert.equal((await allSQL<{ processed: number }>(db, 'SELECT processed FROM BuildMeta'))[0].processed, 0)
		await generateOnDisk(db, 2, 3, gates, options, entries => storeReplacers(db, entries, true))
		await check(db)
	} finally { await close(db) }
	// State-limit rollback after expansion permits a clean retry.
	db = await open('limit.db')
	try {
		await assert.rejects(generateOnDisk(db, 2, 3, gates, { ...options, stateLimit: 1 }, entries => storeReplacers(db, entries, true)), /state limit/)
		await generateOnDisk(db, 2, 3, gates, options, entries => storeReplacers(db, entries, true))
		await check(db)
	} finally { await close(db) }
} finally { await rm(directory, { recursive: true, force: true }) }
for (const key of ['generationWorkers', 'generationQueueBatches', 'generationMinimumWork']) for (const value of [0, -1, 1.5, '4']) assert.throws(() => parseConfig({ database: { [key]: value } }))
console.log('Packed expansion, bounded parallel generation, deterministic results, failure cleanup and resume regressions passed')
