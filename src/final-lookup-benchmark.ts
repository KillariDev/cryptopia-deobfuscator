import sqlite3 from 'sqlite3'
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve, dirname } from 'node:path'
import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { config } from './config.js'
import { allSQL, runSQL, insertRows } from './sql.js'
import { generationLookupSchema, usedWires } from './generation-storage.js'
import { candidateMergeSQL } from './generation-merge.js'
import { countNewFinalFunctionsSQL } from './generation-dedup.js'
import { installFinalCounter, removeFinalCounter, startFinalCounterSQL, readFinalCounterSQL, stopFinalCounterSQL, finalCounterMembershipSQL } from './generation-final-lookup.js'
import { configureGenerationDatabase } from './rainbowtable.js'
const smoke = process.argv.includes('--smoke')
if (process.argv.slice(2).some(arg => arg !== '--smoke')) throw new Error('Usage: npm run benchmark:final-lookup -- [--smoke]')
const populations = smoke ? [100, 1000] : config.benchmark.dedupSeenRows.slice().sort((a,b) => a-b)
const functions = smoke ? 40 : config.benchmark.dedupCandidateFunctions, masks = smoke ? 3 : config.benchmark.dedupMasksPerFunction, repeats = smoke ? 1 : config.benchmark.repeats
const directory = mkdtempSync(join(tmpdir(), 'final-lookup-benchmark-')), db = new sqlite3.Database(join(directory, 'fixture.db'))
const key = (id: number) => { const result = Buffer.alloc(8); result.writeBigUInt64BE(BigInt(id)); return result }
const results: Record<string, any>[] = [], plans: unknown[] = []
const runtimeHash = createHash('sha256')
for (const name of ['generation-final-lookup', 'generation-merge', 'generation-dedup']) { runtimeHash.update(name); runtimeHash.update(readFileSync(new URL(`./${name}.js`, import.meta.url))) }
const expected = new Map<string, string>()
let seeded = 0
try {
	await configureGenerationDatabase(db); await runSQL(db, generationLookupSchema)
	await runSQL(db, 'CREATE TABLE BuildSeen(state BLOB PRIMARY KEY,depth INTEGER NOT NULL) WITHOUT ROWID')
	await runSQL(db, 'CREATE TEMP TABLE BuildCandidates(state BLOB,mask INTEGER,reads INTEGER,gates BLOB,wires INTEGER,PRIMARY KEY(state,mask)) WITHOUT ROWID')
	for (const population of populations) {
		await runSQL(db, 'BEGIN')
		for (; seeded < population;) {
			const rows: unknown[][] = []
			for (let i = 0; i < 1000 && seeded < population; i++, seeded++) rows.push([key(seeded + 1), 4])
			await insertRows(db, 'INSERT INTO BuildSeen VALUES ', rows, '', 900)
		}
		await runSQL(db, 'DELETE FROM InputOutputReplacers')
		await runSQL(db, "INSERT INTO InputOutputReplacers SELECT state,x'fe',4,2,6 FROM BuildSeen")
		await runSQL(db, 'COMMIT')
		plans.push({ population, insertMembership: await allSQL(db, 'EXPLAIN QUERY PLAN ' + finalCounterMembershipSQL, [key(1)]), oldCount: await allSQL(db, 'EXPLAIN QUERY PLAN ' + countNewFinalFunctionsSQL), oldMerge: await allSQL(db, 'EXPLAIN QUERY PLAN ' + candidateMergeSQL(true), [5]) })
		for (const knownFraction of [0, .5, .9]) for (const mode of ['insert/improve', 'equal-cost hits']) {
			const known = Math.floor(functions * knownFraction)
			if (known > population) throw new Error('dedupSeenRows must cover the requested known candidate functions')
			await runSQL(db, 'BEGIN'); await runSQL(db, 'DELETE FROM BuildCandidates'); await runSQL(db, 'DELETE FROM InputOutputReplacers WHERE gateCount=5')
			const candidates: unknown[][] = [], prefix: unknown[][] = []
			for (let i = 0; i < functions; i++) {
				const state = key(i < known ? 1 + Math.floor(i * population / known) : population + i + 1)
				for (let m = 0; m < masks; m++) { const mask = (m + 1) & 255; candidates.push([state, mask, (i * 17 + mask * 7) % 31, Buffer.from([i % 256, mask]), usedWires(mask)]) }
				if (i >= known && i % 2 === 0) prefix.push([state, Buffer.from([255]), 5, 4, 0xffffffff])
			}
			await insertRows(db, 'INSERT INTO BuildCandidates VALUES ', candidates, '', 900)
			await insertRows(db, 'INSERT INTO InputOutputReplacers VALUES ', prefix, '', 900)
			if (mode === 'equal-cost hits') await runSQL(db, candidateMergeSQL(true), [5])
			await runSQL(db, 'COMMIT')
			for (let repeat = 0; repeat < repeats; repeat++) for (const countInserts of repeat % 2 ? [true,false] : [false,true]) {
				if (countInserts) await installFinalCounter(db)
				await runSQL(db, 'BEGIN')
				const start = performance.now()
				if (countInserts) await runSQL(db, startFinalCounterSQL)
				const selectedAt = performance.now()
				let count = countInserts ? 0 : (await allSQL<{ count: number }>(db, countNewFinalFunctionsSQL))[0].count
				const countedAt = performance.now()
				await runSQL(db, candidateMergeSQL(true), [5])
				const appliedAt = performance.now()
				if (countInserts) { count = (await allSQL<{ count: number }>(db, readFinalCounterSQL))[0].count; await runSQL(db, stopFinalCounterSQL) }
				const end = performance.now()
				const rows = await allSQL(db, 'SELECT o.* FROM (SELECT state FROM BuildCandidates GROUP BY state) c CROSS JOIN InputOutputReplacers o ON o.ioIdentifier=c.state ORDER BY c.state')
				const totalRows = (await allSQL<{ count: number }>(db, 'SELECT COUNT(*) AS count FROM InputOutputReplacers'))[0].count
				const digest = createHash('sha256').update(JSON.stringify([count,totalRows,rows])).digest('hex'), id = `${population}/${knownFraction}/${mode}`
				if (expected.has(id) && expected.get(id) !== digest) throw new Error('Final lookup benchmark changed output or function counts')
				expected.set(id,digest)
				results.push({ population, knownFraction, mode, repeat, variant: countInserts ? 'count-inserts' : 'count-candidates', totalMs: end-start, armMs: selectedAt-start, countMs: countedAt-selectedAt, applyMs: appliedAt-countedAt, readCounterMs: end-appliedAt, newFunctions: count, totalRows, digest })
				await runSQL(db, 'ROLLBACK')
				if (countInserts) await removeFinalCounter(db)
			}
			console.log(`Final lookup: ${population} seen rows, ${knownFraction * 100}% shorter-depth candidates, ${mode}: equivalent`)
		}
	}
	const output = resolve(config.files.dataDirectory, smoke ? 'final-lookup-benchmark-smoke.json' : config.benchmark.finalLookupOutputName)
	mkdirSync(dirname(output), { recursive: true })
	writeFileSync(output, JSON.stringify({ schemaVersion: 1, smoke, runtimeSha256: runtimeHash.digest('hex'), revision: execFileSync('git',['rev-parse','HEAD'],{encoding:'utf8'}).trim(), node: process.version, settings: config, functions, masks, results, plans, limitations: 'Metadata/index fixture on one shared host; not functional 4/5 circuits or cold-disk behavior. Includes candidate counting or counter setup/read, and lookup merge with optional insert trigger. Setup, validation, transaction begin/rollback and commit excluded. All shorter-depth fixture states already have output; pending shorter states are covered by unit and complete generation tests.' }, null, 2)+'\n')
	console.log(`Final lookup benchmark saved to ${output}`)
} finally { await new Promise<void>((resolve,reject) => db.close(error => error ? reject(error) : resolve())); rmSync(directory,{recursive:true,force:true}) }
