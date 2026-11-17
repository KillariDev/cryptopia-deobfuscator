import assert from 'node:assert/strict'
import sqlite3 from 'sqlite3'
import { setImmediate as immediate } from 'timers/promises'
import { SQLObserver, observeSQL } from './sql-observer.js'
import { diagnosticDelta, formatDiagnosticSample, GenerationDiagnostics } from './generation-diagnostics.js'
import { allSQL, runSQL } from './sql.js'
import { StagingWriter } from './generation-staging.js'
const io = process.resourceUsage(), loop = { active: 0, idle: 0, utilization: 0 }
const sql = { calls: 0, awaitMs: 0, nativeCalls: 0, nativeMs: 0, active: 0, oldestMs: 0, maxMs: 0 }
const before = { phase: 'staging', at: 1000, cpu: { user: 0, system: 0 }, io, loop, sql, phases: [0, 0, 0, 0, 0] }
const after = { phase: 'staging', at: 2000, cpu: { user: 1200000, system: 300000 }, io: { ...io, fsRead: io.fsRead + 3, fsWrite: io.fsWrite + 4 }, loop: { active: 200, idle: 800, utilization: .2 }, sql: { ...sql, calls: 10, awaitMs: 850, nativeCalls: 8, nativeMs: 700 }, phases: [10, 500, 100, 150, 20] }
const sample = diagnosticDelta(before, after, 2, 104857600, 8)
assert.equal(sample.cores, 1.5); assert.equal(sample.loopBusy, .2); assert.equal(sample.rssMiB, 100)
assert.deepEqual([sample.ioRead, sample.ioWrite], [3, 4])
assert.match(formatDiagnosticSample(sample).join('\n'), /1.50 core-equivalents \/ 8/)
assert.match(formatDiagnosticSample(sample).join('\n'), /includes native/)
const db = new sqlite3.Database(':memory:')
try {
	let existingCalls = 0
	const existing = () => { existingCalls++ }
	db.on('profile', existing)
	const observer = new SQLObserver(db)
	assert.throws(() => new SQLObserver(db), /already active/)
	await runSQL(db, 'CREATE TEMP TABLE BuildCandidates(state BLOB,mask INTEGER,reads INTEGER,gates BLOB,wires INTEGER,PRIMARY KEY(state,mask)) WITHOUT ROWID')
	const writer = await StagingWriter.create(db, { prepared: true, sort: false, parameterLimit: 900, cacheEntries: 2 })
	await writer.write([[Buffer.from([1]), 1, 1, Buffer.from([1]), 1]])
	await writer.close(); await allSQL(db, 'SELECT * FROM BuildCandidates'); await immediate()
	assert.ok(observer.snapshot().calls >= 5, 'SQL helpers and prepared staging calls are observed')
	assert.ok(observer.snapshot().nativeCalls > 0 && existingCalls > 0)
	let release!: () => void
	const pending = observeSQL(db, () => new Promise<void>(resolve => { release = resolve }))
	assert.equal(observer.snapshot().active, 1)
	release(); await pending
	await assert.rejects(observeSQL(db, async () => { throw new Error('observed failure') }), /observed failure/)
	assert.equal(observer.snapshot().active, 0)
	observer.close(); observer.close()
	assert.equal(db.listenerCount('profile'), 1)
	const count = existingCalls
	await allSQL(db, 'SELECT 42'); await immediate(); assert.ok(existingCalls > count)
	db.removeListener('profile', existing)
	assert.throws(() => new GenerationDiagnostics(db, 0, 0))
	assert.equal(db.listenerCount('profile'), 0, 'failed initialization releases the SQL hook')
	const diagnostics = new GenerationDiagnostics(db, 10, 0)
	await allSQL(db, 'SELECT 123'); await immediate()
	const measured = diagnostics.sample()
	assert.ok(measured && Number.isFinite(measured.cores))
	diagnostics.close(); diagnostics.close()
	assert.equal(diagnostics.sample(), undefined)
	assert.equal(db.listenerCount('profile'), 0)
} finally { await new Promise<void>((resolve, reject) => db.close(error => error ? reject(error) : resolve())) }
console.log('Built-in interval CPU, event loop, native SQL, prepared-call coverage and listener cleanup checks passed')
