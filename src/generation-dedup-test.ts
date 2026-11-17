import assert from 'node:assert/strict'
import sqlite3 from 'sqlite3'
import { allSQL, runSQL } from './sql.js'
import { frontierCandidatesSQL, countNewFinalFunctionsSQL } from './generation-dedup.js'
const db = new sqlite3.Database(':memory:')
try {
	await runSQL(db, 'CREATE TABLE BuildSeen(state BLOB PRIMARY KEY,depth INTEGER NOT NULL) WITHOUT ROWID')
	await runSQL(db, 'CREATE TEMP TABLE BuildCandidates(state BLOB,mask INTEGER,reads INTEGER,gates BLOB,PRIMARY KEY(state,mask)) WITHOUT ROWID')
	await runSQL(db, 'CREATE TABLE BuildFrontier(id INTEGER PRIMARY KEY,state BLOB,mask INTEGER,reads INTEGER,gates BLOB,depth INTEGER,UNIQUE(state,mask))')
	await runSQL(db, 'CREATE TABLE InputOutputReplacers(ioIdentifier BLOB PRIMARY KEY) WITHOUT ROWID')
	for (const [key, depth] of [[1, 2], [2, 4], [3, 4]]) await runSQL(db, 'INSERT INTO BuildSeen VALUES (?,?)', [Buffer.from([key]), depth])
	await runSQL(db, 'INSERT INTO InputOutputReplacers VALUES (?)', [Buffer.from([5])])
	for (let key = 1; key <= 6; key++) for (let mask = 0; mask < 8; mask++) await runSQL(db, 'INSERT INTO BuildCandidates VALUES (?,?,?,?)', [Buffer.from([key]), mask, mask + key, Buffer.from([key, mask])])
	const expected = [2, 3].flatMap(key => Array.from({ length: 8 }, (_, mask) => ({ state: Buffer.from([key]), mask, reads: mask + key, gates: Buffer.from([key, mask]), depth: 4 })))
	for (const analyzed of [false, true]) {
		if (analyzed) await runSQL(db, 'ANALYZE')
		const insertPlan = await allSQL<{ detail: string }>(db, 'EXPLAIN QUERY PLAN INSERT INTO BuildFrontier(state,mask,reads,gates,depth) ' + frontierCandidatesSQL + ' ON CONFLICT(state,mask) DO UPDATE SET reads=excluded.reads,gates=excluded.gates WHERE excluded.reads<BuildFrontier.reads', [4, 4])
		assert.ok(insertPlan.every(row => !/SCAN s\b/.test(row.detail)), 'the actual frontier write also avoids a global scan')
		const plan = await allSQL<{ detail: string }>(db, 'EXPLAIN QUERY PLAN ' + frontierCandidatesSQL, [4, 4])
		assert.ok(plan.some(row => /SCAN c\b/.test(row.detail)), 'scan only the bounded batch')
		assert.ok(plan.some(row => /SEARCH s USING PRIMARY KEY/.test(row.detail)), 'probe visited states by exact key')
		assert.ok(plan.every(row => !/SCAN s\b/.test(row.detail)), 'never scan the global visited table per batch')
		const rows = await allSQL(db, 'SELECT state,mask,reads,gates,depth FROM (' + frontierCandidatesSQL.replace(',? FROM', ',? AS depth FROM') + ') ORDER BY state,mask', [4, 4])
		assert.deepEqual(rows, expected, 'keep every same-depth mask, exclude earlier-depth states')
		assert.equal((await allSQL<{ count: number }>(db, countNewFinalFunctionsSQL))[0].count, 2, 'new functions 4 and 6 count once despite mask duplicates; output function 5 is already known')
		const finalPlan = await allSQL<{ detail: string }>(db, 'EXPLAIN QUERY PLAN ' + countNewFinalFunctionsSQL)
		assert.ok(finalPlan.some(row => /CO-ROUTINE c\b/.test(row.detail)), 'group functions before correlated global lookups')
		assert.ok(finalPlan.every(row => !/SCAN [so]\b/.test(row.detail)), 'final function checks use indexed probes')
	}
} finally { await new Promise<void>((resolve, reject) => db.close(error => error ? reject(error) : resolve())) }
console.log('Candidate-driven indexed deduplication, grouped final counts and query-plan regressions passed')
