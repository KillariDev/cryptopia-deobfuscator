import sqlite3 from 'sqlite3'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'fs'
import { tmpdir, cpus } from 'os'
import { join, resolve, dirname } from 'path'
import { createHash } from 'crypto'
import { execFileSync } from 'child_process'
import { config } from './config.js'
import { allSQL, runSQL, insertRows } from './sql.js'
import { frontierCandidatesSQL, countNewFinalFunctionsSQL } from './generation-dedup.js'

const smoke = process.argv.includes('--smoke')
if (process.argv.slice(2).some(arg => arg !== '--smoke')) throw new Error('Usage: npm run benchmark:dedup -- [--smoke]')
const populations = smoke ? [1000, 10000] : config.benchmark.dedupSeenRows.slice().sort((a, b) => a - b)
const functions = smoke ? 100 : config.benchmark.dedupCandidateFunctions, masks = smoke ? 4 : config.benchmark.dedupMasksPerFunction
const repeats = smoke ? 1 : config.benchmark.repeats
const directory = mkdtempSync(join(tmpdir(), 'dedup-benchmark-')), db = new sqlite3.Database(join(directory, 'fixture.db'))
const key = (id: number) => { const buffer = Buffer.alloc(8); buffer.writeBigUInt64BE(BigInt(id)); return buffer }
const output = resolve(config.files.dataDirectory, smoke ? 'dedup-benchmark-smoke.json' : config.benchmark.dedupOutputName)
const records: unknown[] = []
const referenceFrontier = frontierCandidatesSQL.replace('CROSS JOIN', 'JOIN')
const referenceFinal = 'SELECT count(*) AS count FROM (SELECT DISTINCT state FROM BuildCandidates c WHERE NOT EXISTS (SELECT 1 FROM BuildSeen s WHERE s.state=c.state) AND NOT EXISTS (SELECT 1 FROM InputOutputReplacers o WHERE o.ioIdentifier=c.state))'
const queries = { frontier: { reference: referenceFrontier, current: frontierCandidatesSQL }, finalCount: { reference: referenceFinal, current: countNewFinalFunctionsSQL } }
const median = (values: number[]) => { const sorted = values.slice().sort((a, b) => a - b); return (sorted[Math.floor((sorted.length - 1) / 2)] + sorted[Math.floor(sorted.length / 2)]) / 2 }
let seeded = 0
try {
	await runSQL(db, 'PRAGMA journal_mode=WAL')
	await runSQL(db, `PRAGMA cache_size=-${config.database.generationCacheMegabytes * 1024}`)
	await runSQL(db, 'CREATE TABLE BuildSeen(state BLOB PRIMARY KEY,depth INTEGER NOT NULL) WITHOUT ROWID')
	await runSQL(db, 'CREATE TEMP TABLE BuildCandidates(state BLOB,mask INTEGER,reads INTEGER,gates BLOB,PRIMARY KEY(state,mask)) WITHOUT ROWID')
	await runSQL(db, 'CREATE TABLE InputOutputReplacers(ioIdentifier BLOB PRIMARY KEY) WITHOUT ROWID')
	for (const seenRows of populations) {
		await runSQL(db, 'BEGIN')
		for (; seeded < seenRows;) {
			const rows: unknown[][] = []
			for (let j = 0; j < 1000 && seeded < seenRows; j++, seeded++) rows.push([key(seeded), seeded % 2 ? 2 : 4])
			await insertRows(db, 'INSERT INTO BuildSeen VALUES ', rows, '', 900)
		}
		await runSQL(db, 'DELETE FROM BuildCandidates'); await runSQL(db, 'DELETE FROM InputOutputReplacers')
		const known = Math.ceil(functions / 2), candidates: unknown[][] = []
		for (let i = 0; i < functions; i++) {
			const id = i < known ? Math.floor(i * seenRows / known) : seenRows + i
			for (let mask = 0; mask < masks; mask++) candidates.push([key(id), mask, mask + 1, Buffer.from([0, 0, 15])])
			if (i >= known && i % 2 === 0) await runSQL(db, 'INSERT INTO InputOutputReplacers VALUES (?)', [key(id)])
		}
		await insertRows(db, 'INSERT INTO BuildCandidates VALUES ', candidates, '', 900)
		await runSQL(db, 'COMMIT')
		for (const [phase, variants] of Object.entries(queries)) {
			const parameters = phase === 'frontier' ? [4, 4] : []
			const plans = Object.fromEntries(await Promise.all(Object.entries(variants).map(async ([name, query]) => [name, await allSQL(db, 'EXPLAIN QUERY PLAN ' + query, parameters)])))
			const samples: Record<string, number[]> = { reference: [], current: [] }
			let digest: string | undefined, resultRows = 0
			for (let repeat = 0; repeat < repeats; repeat++) for (const variant of repeat % 2 ? ['current', 'reference'] as const : ['reference', 'current'] as const) {
				const started = performance.now(), rows = await allSQL(db, variants[variant], parameters)
				samples[variant].push(performance.now() - started)
				const normalized = rows.map(row => JSON.stringify(row)).sort()
				const actual = createHash('sha256').update(JSON.stringify(normalized)).digest('hex')
				if (digest && digest !== actual) throw new Error('Deduplication benchmark output differs')
				digest = actual; resultRows = rows.length
			}
			const medians = { reference: median(samples.reference), current: median(samples.current) }
			records.push({ phase, seenRows, functions, masks, candidateRows: candidates.length, resultRows, resultDigest: digest, samplesMs: samples, medianMs: medians, speedup: medians.reference / medians.current, plans })
			console.log(`${phase}: ${seenRows.toLocaleString()} visited states, ${candidates.length} candidate rows: ${medians.reference.toFixed(2)}ms → ${medians.current.toFixed(2)}ms`)
		}
	}
	mkdirSync(dirname(output), { recursive: true })
	writeFileSync(output, JSON.stringify({ schemaVersion: 1, smoke, revision: execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(), workingTreeDirty: Boolean(execFileSync('git', ['status', '--porcelain'], { encoding: 'utf8' }).trim()), node: process.version, platform: process.platform, cpu: cpus()[0]?.model, cacheMegabytes: config.database.generationCacheMegabytes, repeats, queries, records, limitations: 'Query-only fixtures on a shared host, not whole generation or production 4/5 throughput. Results include row materialization; validation and setup are excluded. Alternating order shares an SQLite page cache, not cold-disk trials.' }, null, 2) + '\n')
	console.log(`Deduplication benchmark saved to ${output}`)
} finally {
	await new Promise<void>((resolveClose, reject) => db.close(error => error ? reject(error) : resolveClose()))
	rmSync(directory, { recursive: true, force: true })
}
