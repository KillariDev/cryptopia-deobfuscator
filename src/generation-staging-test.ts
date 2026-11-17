import assert from 'node:assert/strict'
import sqlite3 from 'sqlite3'
import { allSQL, runSQL, insertRows } from './sql.js'
import { stagingParameterLimit, StagingWriter, StagingRow } from './generation-staging.js'
import { parseConfig } from './config.js'
const db = new sqlite3.Database(':memory:')
try {
	await runSQL(db, 'CREATE TEMP TABLE BuildCandidates(state BLOB,mask INTEGER,reads INTEGER CHECK(reads>=0),gates BLOB,wires INTEGER,PRIMARY KEY(state,mask)) WITHOUT ROWID')
	const rows: StagingRow[] = Array.from({ length: 251 }, (_, i) => [Buffer.from([i * 13 % 17]), i % 3, (i * 7) % 23, Buffer.from([i % 256]), 2])
	const suffix = ' ON CONFLICT(state,mask) DO UPDATE SET reads=excluded.reads,gates=excluded.gates WHERE excluded.reads<BuildCandidates.reads'
	await insertRows(db, 'INSERT INTO BuildCandidates VALUES ', rows, suffix, 900)
	const expected = await allSQL(db, 'SELECT * FROM BuildCandidates ORDER BY state,mask')
	for (const prepared of [false, true]) for (const sort of [false, true]) for (const append of [false, true]) for (const limit of [10, 900, 8192]) {
		await runSQL(db, 'DELETE FROM BuildCandidates')
		const writer = await StagingWriter.create(db, { prepared, sort, append, parameterLimit: limit, cacheEntries: 2 })
		try {
			await runSQL(db, 'BEGIN')
			// Concurrent calls must serialize bindings; sorting must preserve equal-key ties.
			await Promise.all([writer.write(rows.slice(0, 100)), writer.write(rows.slice(100, 200)), writer.write(rows.slice(200))])
			await writer.materialize()
			await runSQL(db, 'COMMIT')
			assert.deepEqual(await allSQL(db, 'SELECT * FROM BuildCandidates ORDER BY state,mask'), expected)
			assert.ok(writer.stats.peakCached <= 2)
			if (prepared) assert.ok(writer.stats.statementsPrepared < writer.stats.executions || limit > 500)
		} finally { await writer.close() }
		await assert.rejects(writer.write(rows), /closed/)
		await assert.rejects(writer.materialize(), /closed/)
		await writer.close() // idempotent
	}
	const appended = await StagingWriter.create(db, { prepared: true, sort: false, append: true, parameterLimit: 900, cacheEntries: 2 })
	try {
		for (const maximum of [0x7fffffff, 0x80000000]) {
			await runSQL(db, 'DELETE FROM BuildCandidates')
			for (const [offset, reads, gate] of [[2, 0xffffffff, 1], [1, 0xfffffffe, 2], [0, 0xfffffffe, 3]]) await runSQL(db, 'INSERT INTO BuildCandidateRows VALUES (?,?,?,?,?,?)', [maximum - offset, Buffer.from([88]), 1, reads, Buffer.from([gate]), 1])
			await appended.materialize()
			const winner = (await allSQL<{ reads: number, gates: Buffer }>(db, 'SELECT reads,gates FROM BuildCandidates'))[0]
			assert.equal(winner.reads, 0xfffffffe)
			assert.deepEqual(winner.gates, Buffer.from([2]), 'int64-boundary and wide-rowid paths preserve first cheapest tie')
		}
		await runSQL(db, 'DELETE FROM BuildCandidates')
		await runSQL(db, 'BEGIN')
		await appended.write([[Buffer.from([77]), 1, -1, Buffer.from([7]), 1]])
		await assert.rejects(appended.materialize(), /CHECK constraint/)
		await runSQL(db, 'ROLLBACK')
		assert.equal((await allSQL(db, 'SELECT * FROM BuildCandidateRows')).length, 0)
		assert.equal((await allSQL(db, 'SELECT * FROM BuildCandidates')).length, 0)
		await runSQL(db, 'BEGIN')
		await appended.write([[Buffer.from([77]), 1, 1, Buffer.from([7]), 1]])
		await appended.materialize()
		await runSQL(db, 'COMMIT')
		assert.equal((await allSQL(db, 'SELECT * FROM BuildCandidates')).length, 1)
	} finally { await appended.close() }

	const eviction = await StagingWriter.create(db, { prepared: true, sort: false, parameterLimit: 900, cacheEntries: 1 })
	try {
		for (const count of [1, 2, 3, 1]) await eviction.write(rows.slice(0, count))
		assert.equal(eviction.stats.statementsPrepared, 4)
		assert.equal(eviction.stats.peakCached, 1)
	} finally { await eviction.close() }
	await runSQL(db, 'DELETE FROM BuildCandidates')
	const wide = await StagingWriter.create(db, { prepared: true, sort: false, parameterLimit: 32766, cacheEntries: 2 })
	try {
		const many: StagingRow[] = Array.from({ length: 2000 }, (_, i) => { const state = Buffer.alloc(8); state.writeUInt32BE(i, 4); return [state, 0, 1, Buffer.from([1]), 1] })
		await wide.write(many)
		assert.equal((await allSQL<{ count: number }>(db, 'SELECT count(*) AS count FROM BuildCandidates'))[0].count, 2000)
	} finally { await wide.close() }

	const compiled = await stagingParameterLimit(db, 32766)
	assert.ok(compiled >= 5 && compiled <= 32766)
	assert.equal(await stagingParameterLimit(db, 10), 10)
	await assert.rejects(stagingParameterLimit(db, 4), /at least five/)
	await assert.rejects(StagingWriter.create(db, { prepared: true, sort: false, parameterLimit: 900, cacheEntries: 0 }), /cache/)
	const writer = await StagingWriter.create(db, { prepared: true, sort: false, parameterLimit: 900, cacheEntries: 1 })
	try {
		await runSQL(db, 'BEGIN')
		await writer.write([[Buffer.from([99]), 0, 2, Buffer.from([1]), 1]])
		await assert.rejects(writer.write([[Buffer.from([98]), 0, -1, Buffer.from([1]), 1]]), /CHECK constraint/)
		await runSQL(db, 'ROLLBACK')
		assert.equal((await allSQL(db, 'SELECT * FROM BuildCandidates WHERE state IN (?,?)', [Buffer.from([98]), Buffer.from([99])])).length, 0)
		// A failed statement is evicted; a later write prepares a valid replacement.
		await writer.write([[Buffer.from([99]), 0, 2, Buffer.from([1]), 1]])
	} finally { await writer.close() }
	for (const value of [0, 4, 32767, 1.5]) assert.throws(() => parseConfig({ database: { generationSqlParameters: value } }))
} finally { await new Promise<void>((resolve, reject) => db.close(error => error ? reject(error) : resolve())) }
console.log('Prepared staging equivalence, sort ties, parameter limits, bounded caches, rollback and resource cleanup checks passed')
