import assert from 'node:assert/strict'
import sqlite3 from 'sqlite3'
import { allSQL, runSQL } from './sql.js'
import { generationLookupSchema, usedWires } from './generation-storage.js'
import { candidateMergeSQL } from './generation-merge.js'
import { countNewFinalFunctionsSQL } from './generation-dedup.js'
import { installFinalCounter, removeFinalCounter, startFinalCounterSQL, readFinalCounterSQL, stopFinalCounterSQL, finalCounterMembershipSQL } from './generation-final-lookup.js'
const db = new sqlite3.Database(':memory:')
try {
	await runSQL(db, generationLookupSchema)
	await runSQL(db, 'CREATE TABLE BuildSeen(state BLOB PRIMARY KEY,depth INTEGER NOT NULL) WITHOUT ROWID')
	await runSQL(db, 'CREATE TEMP TABLE BuildCandidates(state BLOB,mask INTEGER,reads INTEGER,gates BLOB,wires INTEGER,PRIMARY KEY(state,mask)) WITHOUT ROWID')
	for (let i = 0; i < 30; i++) {
		if (i < 8) await runSQL(db, 'INSERT INTO BuildSeen VALUES (?,4)', [Buffer.from([i])])
		for (const mask of [1, 2, 3, 7, 15]) await runSQL(db, 'INSERT INTO BuildCandidates VALUES (?,?,?,?,?)', [Buffer.from([i]), mask, i % 3 ? (i + mask) % 13 : 0xffffffff - mask % 2, Buffer.from([i, mask]), usedWires(mask)])
	}
	const seed = async () => {
		await runSQL(db, 'DELETE FROM InputOutputReplacers')
		for (let i = 0; i < 24; i++) if (i < 4 || i >= 8) await runSQL(db, 'INSERT INTO InputOutputReplacers VALUES (?,?,?,?,?)', [Buffer.from([i]), Buffer.from([254, i]), i < 4 ? 4 : 4 + i % 3, 1 + i % 4, i % 3 ? 5 : 0xffffffff])
	}
	const snapshots: unknown[][] = [], counts: number[] = []
	for (const aggregate of [false, true]) for (const countInserts of [false, true]) {
		if (countInserts) await installFinalCounter(db)
		await seed(); await runSQL(db, 'BEGIN')
		let count: number
		if (countInserts) await runSQL(db, startFinalCounterSQL)
		else count = (await allSQL<{ count: number }>(db, countNewFinalFunctionsSQL))[0].count
		await runSQL(db, candidateMergeSQL(aggregate), [5])
		if (countInserts) {
			count = (await allSQL<{ count: number }>(db, readFinalCounterSQL))[0].count
			await runSQL(db, stopFinalCounterSQL)
			await runSQL(db, candidateMergeSQL(aggregate), [5])
			assert.equal((await allSQL<{ count: number }>(db, readFinalCounterSQL))[0].count, count, 'equal-cost repeats and updates never fire insert counting')
		}
		counts.push(count!)
		assert.equal((await allSQL<{ gateCount: number }>(db, 'SELECT gateCount FROM InputOutputReplacers WHERE ioIdentifier=?', [Buffer.from([4])]))[0].gateCount, 5, 'pending shorter functions keep identical intermediate output')
		snapshots.push(await allSQL(db, 'SELECT * FROM InputOutputReplacers ORDER BY ioIdentifier'))
		await runSQL(db, 'ROLLBACK')
		if (countInserts) {
			assert.deepEqual(await allSQL(db, readFinalCounterSQL), [{ count: 0 }], 'count and output roll back together')
			await removeFinalCounter(db)
		}
	}
	assert.ok(counts.every(count => count === 6), 'only the six genuinely new functions are counted')
	for (const rows of snapshots) assert.deepEqual(rows, snapshots[0], 'intermediate costs, exact ties, payloads and coverage match')
	await installFinalCounter(db)
	for (const analyzed of [false, true]) {
		if (analyzed) await runSQL(db, 'ANALYZE')
		const plan = await allSQL<{ detail: string }>(db, 'EXPLAIN QUERY PLAN ' + finalCounterMembershipSQL, [Buffer.from([1])])
		assert.ok(plan.some(row => /SEARCH s USING PRIMARY KEY/.test(row.detail)))
		assert.ok(plan.every(row => !/SCAN s\b/.test(row.detail)))
	}
	await removeFinalCounter(db)
} finally { await new Promise<void>((resolve, reject) => db.close(error => error ? reject(error) : resolve())) }
console.log('Final insert counting: exact intermediate output, counts, pending shorter circuits, cost ties, indexed membership and rollback passed')
