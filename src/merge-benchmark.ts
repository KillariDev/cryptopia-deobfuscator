import sqlite3 from 'sqlite3'
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join, resolve, dirname } from 'path'
import { createHash } from 'crypto'
import { execFileSync } from 'child_process'
import { config } from './config.js'
import { allSQL, runSQL } from './sql.js'
import { StagingWriter } from './generation-staging.js'
import { makeStagingFixture } from './staging-fixture.js'
import { generationLookupSchema } from './generation-storage.js'
import { configureGenerationDatabase } from './rainbowtable.js'
import { candidateMergeSQL } from './generation-merge.js'
const smoke = process.argv.includes('--smoke')
if (process.argv.slice(2).some(arg => arg !== '--smoke')) throw new Error('Usage: npm run benchmark:merge -- [--smoke]')
const fixture = makeStagingFixture(smoke ? 2000 : config.benchmark.stagingRows, config.database.generationBatchRows, config.benchmark.seed)
const directory = mkdtempSync(join(tmpdir(), 'merge-benchmark-')), db = new sqlite3.Database(join(directory, 'fixture.db'))
const results: unknown[] = [], repeats = smoke ? 1 : config.benchmark.repeats
let expected: string | undefined, writer: StagingWriter | undefined
try {
	await configureGenerationDatabase(db)
	await runSQL(db, generationLookupSchema)
	await runSQL(db, 'CREATE TEMP TABLE BuildCandidates(state BLOB NOT NULL,mask INTEGER NOT NULL,reads INTEGER NOT NULL,gates BLOB NOT NULL,wires INTEGER NOT NULL,PRIMARY KEY(state,mask)) WITHOUT ROWID')
	writer = await StagingWriter.create(db, { parameterLimit: config.database.generationSqlParameters, prepared: true, sort: false, cacheEntries: config.database.generationStatementCacheEntries })
	await runSQL(db, 'BEGIN')
	for (let i = 0; i < fixture.length; i += config.database.generationBatchRows) await writer.write(fixture.slice(i, i + config.database.generationBatchRows))
	await runSQL(db, 'COMMIT'); await writer.close()
	for (let repeat = 0; repeat < repeats; repeat++) for (const aggregate of repeat % 2 ? [true, false] : [false, true]) {
		await runSQL(db, 'DELETE FROM InputOutputReplacers')
		await runSQL(db, 'BEGIN')
		const start = performance.now(); await runSQL(db, candidateMergeSQL(aggregate), [5]); const insertMs = performance.now() - start
		const hitStart = performance.now(); await runSQL(db, candidateMergeSQL(aggregate), [5]); const hitMs = performance.now() - hitStart
		await runSQL(db, 'COMMIT')
		const hash = createHash('sha256'); let rows = 0
		await new Promise<void>((resolveRows, reject) => db.each('SELECT * FROM InputOutputReplacers ORDER BY ioIdentifier', (error: Error | null, row: unknown) => {
			if (error) { reject(error); return }
			hash.update(JSON.stringify(row)); rows++
		}, (error: Error | null) => error ? reject(error) : resolveRows()))
		const digest = hash.digest('hex')
		if (expected && expected !== digest) throw new Error('Lookup merge changed payloads or replacement costs')
		expected = digest
		const plan = await allSQL(db, 'EXPLAIN QUERY PLAN ' + candidateMergeSQL(aggregate), [5])
		results.push({ repeat, variant: aggregate ? 'aggregate' : 'window', insertMs, hitMs, rows, digest, plan })
		console.log(`${aggregate ? 'aggregate' : 'window'} repeat ${repeat + 1}: insert ${insertMs.toFixed(1)}ms, equal-cost hits ${hitMs.toFixed(1)}ms; ${rows} identical functions`)
	}
	const output = resolve(config.files.dataDirectory, smoke ? 'merge-benchmark-smoke.json' : config.benchmark.mergeOutputName)
	mkdirSync(dirname(output), { recursive: true })
	writeFileSync(output, JSON.stringify({ schemaVersion: 1, smoke, revision: execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(), node: process.version, settings: config, results, limitations: 'Single connection/shared host, staging fixture prepared outside timing. Timings include only each merge statement; commit, setup and validation excluded. Insert starts with empty output; hit repeats identical candidates. Not full production throughput.' }, null, 2) + '\n')
	console.log(`Merge benchmark saved to ${output}`)
} finally {
	try { await writer?.close() } finally { await new Promise<void>((resolveClose, reject) => db.close(error => error ? reject(error) : resolveClose())) }
	rmSync(directory, { recursive: true, force: true })
}
