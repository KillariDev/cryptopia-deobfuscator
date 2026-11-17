import { WriterUtilization } from './generation-utilization.js'
import sqlite3 from 'sqlite3'
import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { runSQL } from './sql.js'
import { observeRelatedSQL } from './sql-observer.js'
import { StagingOptions, StagingRow, StagingWriter } from './generation-staging.js'

export type ShardOptions = StagingOptions & { writers: number, directory?: string, cacheMegabytes: number }
type Shard = { db: sqlite3.Database, alias: string, attached: boolean, writer?: StagingWriter, observing: () => void, transaction: boolean, pending: StagingRow[], pageRows: number, submittedRows: number }
const closeDB = (db: sqlite3.Database) => new Promise<void>((resolve, reject) => db.close(error => error ? reject(error) : resolve()))
/** Hash only the exact function key: all masks and ties for a function share an owner. */
export function stagingShard(state: Buffer, count: number) {
	let hash = 2166136261
	for (const byte of state) hash = Math.imul(hash ^ byte, 16777619)
	// Packed circuit keys have structured low bits. FNV's raw low bits sent
	// almost all such keys to one shard when count was 2 or 4. Avalanche the
	// full hash before reducing it to a power-of-two writer count.
	hash ^= hash >>> 16
	hash = Math.imul(hash, 0x85ebca6b)
	hash ^= hash >>> 13
	hash = Math.imul(hash, 0xc2b2ae35)
	hash ^= hash >>> 16
	return (hash >>> 0) % count
}

/** Scratch writers hold no authoritative state. The main transaction imports their
 * completed batch before updating its frontier/checkpoint. No depth-wide merge is needed. */
export class ShardedStagingWriter {
	private shards: Shard[] = []
	private closing?: Promise<void>
	private accepting = false
	private readyToImport = false
	private active = 0
	private utilization!: WriterUtilization
	private tail: Promise<unknown> = Promise.resolve()
	private constructor(private owner: sqlite3.Database, readonly directory: string) {}
	get activity() { return { ...this.utilization.snapshot(), stagingWriters: this.shards.length, activeStagingWriters: this.active, stagingBufferedRows: this.shards.reduce((sum, shard) => sum + shard.pending.length, 0), stagingRows: this.shards.map(shard => shard.submittedRows) } }
	static async create(owner: sqlite3.Database, options: ShardOptions) {
		if (!Number.isSafeInteger(options.writers) || options.writers < 2 || options.writers > 4 || !Number.isSafeInteger(options.cacheMegabytes) || options.cacheMegabytes < 1) throw new Error('Invalid staging writer limits (2–4 writers)')
		const root = options.directory ?? tmpdir()
		await mkdir(root, { recursive: true })
		const instance = new ShardedStagingWriter(owner, await mkdtemp(join(root, 'rainbow-staging-')))
		instance.utilization = new WriterUtilization(options.writers)
		try {
			for (let i = 0; i < options.writers; i++) {
				const path = join(instance.directory, `writer-${i}.db`), db = new sqlite3.Database(path)
				const shard: Shard = { db, alias: `generation_stage_${i}`, attached: false, observing: () => {}, transaction: false, pending: [], pageRows: 1, submittedRows: 0 }
				instance.shards.push(shard); shard.observing = observeRelatedSQL(owner, db)
				// Regenerated from the main checkpoint after any failure: scratch data
				// needs no fsync. WAL lets the main connection read completed batches.
				await runSQL(db, 'PRAGMA journal_mode=WAL'); await runSQL(db, 'PRAGMA synchronous=OFF')
				await runSQL(db, `PRAGMA cache_size=-${Math.max(1, Math.floor(options.cacheMegabytes * 1024 / options.writers))}`)
				await runSQL(db, 'PRAGMA wal_autocheckpoint=1000')
				await runSQL(db, 'CREATE TABLE BuildCandidates(state BLOB NOT NULL,mask INTEGER NOT NULL,reads INTEGER NOT NULL,gates BLOB NOT NULL,wires INTEGER NOT NULL,PRIMARY KEY(state,mask)) WITHOUT ROWID')
				shard.writer = await StagingWriter.create(db, { ...options, append: false })
				shard.pageRows = Math.floor(shard.writer.parameterLimit / (options.compactBindings ? 3 : 5))
				await runSQL(owner, `ATTACH DATABASE ? AS ${shard.alias}`, [path]); shard.attached = true
			}
			return instance
		} catch (error) { await instance.close().catch(() => {}); throw error }
	}
	/** Must run outside the owner's transaction, after its previous read locks end. */
	async beginBatch() {
		if (this.closing || this.accepting || this.readyToImport) throw new Error('Staging batch is already active or closed')
		await this.tail
		const results = await Promise.allSettled(this.shards.map(shard => this.utilization.measure(async () => {
			await runSQL(shard.db, 'BEGIN IMMEDIATE'); shard.transaction = true
			await runSQL(shard.db, 'DELETE FROM BuildCandidates')
		})))
		for (const result of results) if (result.status === 'rejected') throw result.reason
		this.accepting = true
	}
	private async flush(shard: Shard, final = false) {
		const count = final ? shard.pending.length : Math.floor(shard.pending.length / shard.pageRows) * shard.pageRows
		if (!count) return
		const rows = shard.pending.splice(0, count)
		this.active++
		try { await this.utilization.measure(() => shard.writer!.write(rows)) } finally { this.active-- }
	}
	write(rows: StagingRow[]): Promise<void> {
		if (this.closing || !this.accepting) return Promise.reject(new Error('No active staging batch'))
		const task = this.tail.then(async () => {
			const groups: StagingRow[][] = Array.from({ length: this.shards.length }, () => [])
			for (const row of rows) groups[stagingShard(row[0], groups.length)].push(row)
			// Await every writer even after failure; callers may then roll back safely.
			const results = await Promise.allSettled(groups.map(async (group, i) => {
				if (!group.length) return
				const shard = this.shards[i]
				shard.submittedRows += group.length
				for (const row of group) shard.pending.push(row)
				await this.flush(shard)
			}))
			for (const result of results) if (result.status === 'rejected') throw result.reason
		})
		this.tail = task // A failed batch stays failed until discarded, never materialized.
		return task
	}
	async materialize() {
		if (this.closing || !this.accepting) throw new Error('No active staging batch')
		this.accepting = false
		await this.tail
		const results = await Promise.allSettled(this.shards.map(async shard => {
			await this.flush(shard, true)
			await this.utilization.measure(() => runSQL(shard.db, 'COMMIT')); shard.transaction = false
		}))
		for (const result of results) if (result.status === 'rejected') throw result.reason
		this.readyToImport = true
	}
	async importBatch() {
		if (this.closing || !this.readyToImport) throw new Error('No committed staging batch to import')
		this.readyToImport = false
		// State ownership makes these disjoint: no second deduplication pass or
		// JS roundtrip is needed. Insertion order cannot change equal-cost ties.
		for (const shard of this.shards) await runSQL(this.owner, `INSERT INTO temp.BuildCandidates SELECT * FROM ${shard.alias}.BuildCandidates`)
	}
	close() {
		return this.closing ??= (async () => {
			await this.tail.catch(() => {})
			const errors: unknown[] = []
			for (const shard of this.shards) {
				try { if (shard.transaction) await runSQL(shard.db, 'ROLLBACK') } catch (error) { errors.push(error) }
				try { await shard.writer?.close() } catch (error) { errors.push(error) }
				try { if (shard.attached) await runSQL(this.owner, `DETACH DATABASE ${shard.alias}`) } catch (error) { errors.push(error) }
				shard.observing()
				try { await closeDB(shard.db) } catch (error) { errors.push(error) }
			}
			// Close all connections before removal (also required on Windows).
			if (!errors.length) await rm(this.directory, { recursive: true, force: true })
			if (errors.length) throw errors[0]
		})()
	}
}
