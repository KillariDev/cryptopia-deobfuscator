import assert from 'node:assert/strict'
import sqlite3 from 'sqlite3'
import { mkdtemp, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { allSQL, runSQL } from './sql.js'
import { SQLObserver } from './sql-observer.js'
import { ShardedStagingWriter, stagingShard } from './generation-shards.js'
import { StagingRow, StagingWriter } from './generation-staging.js'
import { makeStagingFixture } from './staging-fixture.js'
import { parseConfig } from './config.js'
const directory = await mkdtemp(join(tmpdir(), 'staging-shards-test-'))
const db = new sqlite3.Database(join(directory, 'owner.db'))
const observer = new SQLObserver(db)
try {
	await runSQL(db, 'CREATE TEMP TABLE BuildCandidates(state BLOB NOT NULL,mask INTEGER NOT NULL,reads INTEGER NOT NULL,gates BLOB NOT NULL,wires INTEGER NOT NULL,PRIMARY KEY(state,mask)) WITHOUT ROWID')
	const options = { prepared: true, sort: false, parameterLimit: 40, cacheEntries: 2 }
	const rows: StagingRow[] = Array.from({ length: 300 }, (_, i) => [Buffer.from([i % 13]), i % 7, i % 11, Buffer.from([i % 256]), 2])
	const reference = await StagingWriter.create(db, options)
	await reference.write(rows); await reference.close()
	const select = () => allSQL(db, 'SELECT * FROM BuildCandidates ORDER BY state,mask')
	const expected = await select()
	for (const writers of [2, 4]) for (const compactBindings of [false, true]) {
		const shards = await ShardedStagingWriter.create(db, { ...options, compactBindings, writers, directory, cacheMegabytes: 4 })
		try {
			assert.equal((await allSQL(db, 'PRAGMA database_list')).length, writers + 2)
			await assert.rejects(shards.importBatch(), /No committed/)
			for (let batch = 0; batch < 2; batch++) {
				await shards.beginBatch(); await runSQL(db, 'BEGIN')
				await runSQL(db, 'DELETE FROM BuildCandidates')
				await Promise.all([shards.write(rows.slice(0, 101)), shards.write(rows.slice(101))])
				await shards.materialize(); await shards.importBatch()
				await assert.rejects(shards.importBatch(), /No committed/)
				assert.deepEqual(await select(), expected, 'exact representatives, including equal-cost ties, survive partition and merge')
				await runSQL(db, batch ? 'ROLLBACK' : 'COMMIT')
			}
			await shards.beginBatch(); await runSQL(db, 'BEGIN')
			await runSQL(db, 'DELETE FROM BuildCandidates')
			await shards.write([[Buffer.from([201]), 255, 0xffffffff, Buffer.from([99]), 8]])
			await shards.materialize(); await shards.importBatch()
			const maximum = (await allSQL<{ mask: number, reads: number, wires: number }>(db, 'SELECT mask,reads,wires FROM BuildCandidates'))[0]
			assert.deepEqual(maximum, { mask: 255, reads: 0xffffffff, wires: 8 })
			await runSQL(db, 'ROLLBACK')
		} finally { await shards.close(); await shards.close() }
		assert.ok(shards.activity.writerMs > 0 && shards.activity.allBusyMs > 0, 'completed scratch work retains interval occupancy and overlap')
		assert.deepEqual(await select(), expected, 'rollback preserves the authoritative checkpoint')
		assert.equal((await allSQL(db, 'PRAGMA database_list')).length, 2)
		assert.deepEqual((await readdir(directory)).filter(name => name.startsWith('rainbow-staging-')), [])
	}
	const shards = await ShardedStagingWriter.create(db, { ...options, writers: 4, directory, cacheMegabytes: 4 })
	try {
		await runSQL(db, "CREATE TRIGGER generation_stage_0.fail BEFORE INSERT ON BuildCandidates BEGIN SELECT RAISE(ABORT,'injected shard failure'); END")
		await shards.beginBatch(); await runSQL(db, 'BEGIN')
		await assert.rejects(shards.write(rows), /injected shard failure/)
		await assert.rejects(shards.materialize(), /injected shard failure/)
		await assert.rejects(shards.importBatch(), /No committed/)
		await runSQL(db, 'ROLLBACK')
	} finally { await shards.close() }
	assert.equal(observer.snapshot().active, 0)
	assert.ok(observer.related.length >= 4 && observer.related.some(child => child.snapshot().calls > 20), 'diagnostics include independent writer connections')
	for (const count of [0, 3, 5, 1.5]) assert.throws(() => parseConfig({ database: { generationStagingWriters: count } }))
	assert.throws(() => parseConfig({ database: { generationStagingWriters: 2, generationAppendStaging: true } }))
	assert.throws(() => parseConfig({ benchmark: { generationWriterComparison: true, generationPrefetchComparison: true } }))
	assert.deepEqual(new Set(Array.from({ length: 256 }, (_, i) => stagingShard(Buffer.from([i]), 4))).size, 4)
} finally {
	observer.close()
	await new Promise<void>((resolve, reject) => db.close(error => error ? reject(error) : resolve()))
	await rm(directory, { recursive: true, force: true })
}
console.log('Independent staging writers: exact ties, repeated batches, rollback, shard errors, diagnostics and file cleanup passed')

// Structured packed truth tables are the real routing workload. Uniform random
// bytes (or every one-byte key) miss the severe low-bit bias of the old hash.
for (const seed of [1729, 1927, 8128]) {
	const candidates = makeStagingFixture(20000, 3000, seed)
	for (const count of [2, 4]) {
		const buckets = Array(count).fill(0)
		const owners = new Map<string, number>()
		for (const [state] of candidates) {
			const shard = stagingShard(state, count), key = state.toString('hex')
			if (owners.has(key)) assert.equal(shard, owners.get(key), 'all masks and repeated keys keep one owner')
			owners.set(key, shard); buckets[shard]++
		}
		const expected = candidates.length / count
		assert.ok(buckets.every(rows => rows > expected * .8 && rows < expected * 1.2), `Structured routing is unbalanced: ${buckets}`)
	}
}
console.log('Packed 4-wire/5-gate candidate routing stays balanced across two/four writers and multiple seeds')
