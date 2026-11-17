import assert from 'node:assert/strict'
import sqlite3 from 'sqlite3'
import { allSQL, runSQL, insertRows } from './sql.js'
import { candidateWinnersSQL, candidateMergeSQL } from './generation-merge.js'
import { generationLookupSchema, usedWires } from './generation-storage.js'
const db = new sqlite3.Database(':memory:')
type Row = { state: Buffer, mask: number, reads: number, gates: Buffer, wires: number }
const oracle = (rows: Row[]) => {
	const map = new Map<string, Row>()
	for (const row of rows) {
		const key = row.state.toString('hex'), old = map.get(key)
		if (!old || row.wires < old.wires || row.wires === old.wires && (row.reads < old.reads || row.reads === old.reads && row.mask < old.mask)) map.set(key, row)
	}
	return [...map.values()].sort((a, b) => Buffer.compare(a.state, b.state)).map(({ state, gates, wires, reads }) => ({ state, gates, wires, reads }))
}
try {
	await runSQL(db, 'CREATE TEMP TABLE BuildCandidates(state BLOB,mask INTEGER,reads INTEGER,gates BLOB,wires INTEGER,PRIMARY KEY(state,mask)) WITHOUT ROWID')
	await runSQL(db, 'CREATE TABLE BuildFrontier(id INTEGER PRIMARY KEY,state BLOB,mask INTEGER,reads INTEGER,gates BLOB,depth INTEGER,UNIQUE(state,mask))')
	await runSQL(db, 'CREATE INDEX BuildFrontierDepth ON BuildFrontier(depth,id)')
	await runSQL(db, generationLookupSchema)
	const fixture: Row[] = []
	for (let i = 0; i < 200; i++) for (const mask of [1, 2, 4, 8, 3, 5, 7, 15]) {
		// Include uint32 boundaries, mixed wire costs, and equal-read ties.
		const reads = i % 4 === 0 ? 0xffffffff - mask % 2 : i % 4 === 1 ? 5 : (i * 17 + mask * 7) % 1000
		fixture.push({ state: Buffer.from([i]), mask, reads, gates: Buffer.from([i, mask]), wires: usedWires(mask) })
	}
	await insertRows(db, 'INSERT INTO BuildCandidates VALUES ', fixture.map(r => [r.state, r.mask, r.reads, r.gates, r.wires]), '', 900)
	for (const aggregate of [false, true]) {
		const rows = await allSQL<Row>(db, 'SELECT * FROM (' + candidateWinnersSQL(aggregate) + ') ORDER BY state')
		assert.deepEqual(rows, oracle(fixture))
	}
	const plan = await allSQL<{ detail: string }>(db, 'EXPLAIN QUERY PLAN ' + candidateWinnersSQL(true))
	assert.ok(plan.every(row => !/ORDER BY/.test(row.detail)), 'stream groups instead of window-ranking candidates')
	const snapshots: unknown[][] = []
	for (const aggregate of [false, true]) {
		await runSQL(db, 'DELETE FROM InputOutputReplacers')
		// Exercise shorter/equal/longer existing circuits and same-gate cost updates.
		for (let i = 0; i < 200; i++) await runSQL(db, 'INSERT INTO InputOutputReplacers VALUES (?,?,?,?,?)', [Buffer.from([i]), Buffer.from([255]), 4 + i % 3, i % 5, i % 13])
		await runSQL(db, candidateMergeSQL(aggregate), [5])
		snapshots.push(await allSQL(db, 'SELECT * FROM InputOutputReplacers ORDER BY ioIdentifier'))
	}
	assert.deepEqual(snapshots[1], snapshots[0], 'upsert cost decisions and payloads stay exact')
	await insertRows(db, 'INSERT INTO BuildFrontier(state,mask,reads,gates,depth) VALUES ', fixture.map((r, i) => [r.state, r.mask, r.reads, r.gates, i % 3 ? 4 : 5]), '', 900)
	await runSQL(db, 'DELETE FROM BuildFrontier WHERE id<20')
	const limit = 813
	const selected = await allSQL<{ state: Buffer, mask: number, reads: number, gates: Buffer }>(db, 'SELECT state,mask,reads,gates FROM BuildFrontier WHERE depth=4 AND id<=?', [limit])
	for (const aggregate of [false, true]) {
		await runSQL(db, 'DELETE FROM InputOutputReplacers')
		await runSQL(db, candidateMergeSQL(aggregate, true), [4, 4, limit])
		const actual = await allSQL(db, 'SELECT ioIdentifier AS state,replacerGates AS gates,wireCount AS wires,readCount AS reads FROM InputOutputReplacers ORDER BY state')
		assert.deepEqual(actual, oracle(selected.map(row => ({ ...row, wires: usedWires(row.mask) }))), 'only the selected depth/id prefix contributes')
		const inputPlan = await allSQL<{ detail: string }>(db, 'EXPLAIN QUERY PLAN ' + candidateMergeSQL(aggregate, true), [4, 4, limit])
		assert.ok(inputPlan.some(row => /SEARCH BuildFrontier USING INDEX BuildFrontierDepth/.test(row.detail)), 'input merge uses the bounded depth/id index')
		assert.ok(inputPlan.every(row => !/SCAN BuildFrontier/.test(row.detail)))
	}
} finally { await new Promise<void>((resolve, reject) => db.close(error => error ? reject(error) : resolve())) }
console.log('Aggregate lookup winner selection, uint32 costs, exact ties, upserts and bounded direct input merge checks passed')
