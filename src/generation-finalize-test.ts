import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, statSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import sqlite3 from 'sqlite3'
import { config } from './config.js'
import { runSQL, allSQL } from './sql.js'
import { generationLookupSchema } from './generation-storage.js'
import { generateOnDisk } from './disk-generation.js'
import { finalizeGeneration } from './generation-finalize.js'
import { createRainbowTable, generateAllGates, configureGenerationDatabase, closeRainbowTable, hasCanonicalCoverage } from './rainbowtable.js'

const directory = mkdtempSync(join(tmpdir(), 'generation-finalize-')), saved = structuredClone(config)
const path = join(directory, 'rainbow_2_3.db')
let db = new sqlite3.Database(path)
try {
	config.files.databaseDirectory = directory
	await configureGenerationDatabase(db)
	await runSQL(db, generationLookupSchema)
	await runSQL(db, 'CREATE TABLE GenerationStatus(id INTEGER PRIMARY KEY,complete INTEGER NOT NULL)')
	await runSQL(db, 'INSERT INTO GenerationStatus VALUES(1,0)')
	await generateOnDisk(db, 2, 3, [...generateAllGates(2)], { readRows: 20, stageRows: 100, parameterLimit: 900, stateLimit: 0, keepState: true, workers: 1, appendStaging: true })
	const output = () => allSQL(db, 'SELECT ioIdentifier,replacerGates FROM InputOutputReplacers ORDER BY ioIdentifier')
	const expected = await output()
	// Make build-only space substantial enough to verify physical reclamation.
	await runSQL(db, 'INSERT INTO BuildSeen VALUES(zeroblob(1048576),0)')
	await allSQL(db, 'PRAGMA wal_checkpoint(TRUNCATE)')
	const originalBytes = statSync(path).size
	const nativeRun = db.run.bind(db)
	let failAt = 'INSERT INTO FinishedOutput'
	db.run = ((sql: string, ...args: unknown[]) => {
		if (sql.startsWith(failAt)) {
			queueMicrotask(() => (args[args.length - 1] as Function)(new Error('injected finalization failure')))
			return db
		}
		return (nativeRun as Function)(sql, ...args)
	}) as typeof db.run
	await assert.rejects(finalizeGeneration(db), /injected finalization failure/)
	assert.equal((await allSQL<{ complete: number }>(db, 'SELECT complete FROM GenerationStatus'))[0].complete, 0)
	assert.equal((await allSQL(db, 'PRAGMA table_info(InputOutputReplacers)')).length, 5)
	assert.deepEqual(await output(), expected)
	assert.equal((await allSQL(db, "SELECT name FROM sqlite_master WHERE name='BuildSeen'")).length, 1)

	failAt = 'VACUUM'
	await assert.rejects(finalizeGeneration(db), /injected finalization failure/)
	assert.equal((await allSQL<{ complete: number }>(db, 'SELECT complete FROM GenerationStatus'))[0].complete, 2)
	assert.equal((await allSQL(db, 'PRAGMA table_info(InputOutputReplacers)')).length, 2)
	assert.equal((await allSQL(db, "SELECT name FROM sqlite_temp_master WHERE name IN ('BuildCandidates','BuildCandidateRows')")).length, 0)
	assert.deepEqual(await output(), expected)
	db.run = nativeRun
	await closeRainbowTable(db)
	// Public job initialization retries compaction, without regenerating output.
	db = await createRainbowTable(2, 3)
	assert.deepEqual(await output(), expected)
	assert.equal((await allSQL<{ complete: number }>(db, 'SELECT complete FROM GenerationStatus'))[0].complete, 1)
	assert.equal((await allSQL(db, "SELECT name FROM sqlite_master WHERE name IN ('BuildSeen','BuildFrontier','BuildLayers','FinishedOutput','FinishedMeta')")).length, 0)
	assert.deepEqual((await allSQL<{ name: string }>(db, 'PRAGMA table_info(BuildMeta)')).map(row => row.name), ['id', 'signature', 'depth'])
	assert.equal((await allSQL<{ freelist_count: number }>(db, 'PRAGMA freelist_count'))[0].freelist_count, 0)
	assert.equal((await allSQL<{ integrity_check: string }>(db, 'PRAGMA integrity_check'))[0].integrity_check, 'ok')
	assert.ok(statSync(path).size < originalBytes / 2)
	assert.equal(statSync(path + '-wal').size, 0)
	assert.equal(await hasCanonicalCoverage(db, 2, 3), true)
	await closeRainbowTable(db)
	db = await createRainbowTable(2, 3)
	assert.deepEqual(await output(), expected)
	assert.equal(await hasCanonicalCoverage(db, 2, 3), true)
} finally {
	await closeRainbowTable(db)
	Object.assign(config, saved)
	rmSync(directory, { recursive: true, force: true })
}
console.log('Automatic cleanup, cost stripping, compaction, failure recovery and completed-table reuse checks passed')
