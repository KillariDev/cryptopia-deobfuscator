import sqlite3 from 'sqlite3'
import { Gate, InputOutputReplacer } from './types.js'
import { circuitState, decodeGates, encodeGates } from './semantic.js'
import { hashGates } from './utils.js'
import { runSQL, allSQL, insertRows } from './sql.js'
import { GenerationProfile, SemanticProgress } from './generation-progress.js'
import { ExpansionKernel, stateIdentifier } from './generation-expansion.js'
import { GenerationPool } from './generation-pool.js'
import { expandBatch } from './generation-pipeline.js'

type Meta = { signature: string, depth: number, processed: number, total: number, functions: number }
type Entry = { id: number, state: Buffer, mask: number, reads: number, gates: Buffer }
export type DiskGenerationOptions = { readRows: number, stageRows: number, parameterLimit: number, stateLimit: number, keepState: boolean, workers?: number, queueBatches?: number, minimumWork?: number, onProfile?: (profile: GenerationProfile) => void }

/** One committed batch owns both its results and its frontier advance. */
export async function generateOnDisk(db: sqlite3.Database, wires: number, maximumDepth: number, catalog: Gate[], options: DiskGenerationOptions,
	store: (entries: Map<string, InputOutputReplacer>) => Promise<void>, onProgress?: (progress: SemanticProgress) => void, shouldPause?: () => boolean) {
	const workers = options.workers ?? 1, queueBatches = options.queueBatches ?? 2, minimumWork = options.minimumWork ?? 100000
	for (const value of [workers, queueBatches, minimumWork, options.readRows, options.stageRows, options.parameterLimit]) if (!Number.isSafeInteger(value) || value < 1) throw new Error('Invalid generation pipeline limits')
	const started = performance.now()
	const profile: GenerationProfile = { elapsedMs: 0, expansionMs: 0, writeMs: 0, readMs: 0, waitMs: 0, candidates: 0, emitted: 0, batches: 0, workersUsed: 0, peakPending: 0 }
	const timeWrite = async <T>(operation: () => Promise<T>) => {
		const start = performance.now()
		try { return await operation() } finally { profile.writeMs += performance.now() - start }
	}
	const run = (sql: string, params: unknown[] = []) => timeWrite(() => runSQL(db, sql, params))
	const read = async <T>(sql: string, params: unknown[] = []) => {
		const start = performance.now()
		try { return await allSQL<T>(db, sql, params) } finally { profile.readMs += performance.now() - start }
	}
	await run('CREATE TABLE IF NOT EXISTS BuildMeta (id INTEGER PRIMARY KEY, signature TEXT NOT NULL, depth INTEGER NOT NULL, processed INTEGER NOT NULL, total INTEGER NOT NULL, functions INTEGER NOT NULL)')
	await run('CREATE TABLE IF NOT EXISTS BuildSeen (state BLOB PRIMARY KEY, depth INTEGER NOT NULL) WITHOUT ROWID')
	await run('CREATE TABLE IF NOT EXISTS BuildFrontier (id INTEGER PRIMARY KEY, state BLOB NOT NULL, mask INTEGER NOT NULL, reads INTEGER NOT NULL, gates BLOB NOT NULL, depth INTEGER NOT NULL, UNIQUE(state,mask))')
	await run('CREATE INDEX IF NOT EXISTS BuildFrontierDepth ON BuildFrontier(depth,id)')
	// A whole read batch is deduplicated here; allow its staging data to spill to disk.
	await run('PRAGMA temp_store=FILE')
	await run('CREATE TEMP TABLE IF NOT EXISTS BuildCandidates (state BLOB NOT NULL, mask INTEGER NOT NULL, reads INTEGER NOT NULL, gates BLOB NOT NULL, PRIMARY KEY(state,mask)) WITHOUT ROWID')
	const signature = `labeled-sorted-v1:${wires}:${maximumDepth}:${hashGates(catalog)}`
	let meta = (await read<Meta>('SELECT * FROM BuildMeta WHERE id=1'))[0]
	if (meta && meta.signature !== signature) throw new Error('Cannot resume generation with a different catalog or wire/gate limits')
	if (!meta) {
		const identity = Buffer.from(circuitState([], wires))
		await run('BEGIN IMMEDIATE')
		try {
			await run('INSERT INTO BuildSeen VALUES (?,0)', [identity])
			await run('INSERT INTO BuildFrontier(state,mask,reads,gates,depth) VALUES (?,0,0,?,0)', [identity, Buffer.alloc(0)])
			await run('INSERT INTO BuildMeta VALUES (1,?,0,0,1,1)', [signature])
			await run('COMMIT')
		} catch (error) { await run('ROLLBACK'); throw error }
		meta = { signature, depth: 0, processed: 0, total: 1, functions: 1 }
	}
	const encoded = catalog.map(gate => encodeGates([gate]))
	const kernel = new ExpansionKernel(wires, catalog)
	const pool = new GenerationPool(workers, wires, catalog)
	let startDepth = meta.depth, startProcessed = meta.processed
	const report = () => {
		profile.elapsedMs = performance.now() - started; profile.workersUsed = pool.workerCount
		options.onProfile?.({ ...profile })
		onProgress?.({ depth: meta.depth, processed: meta.processed, total: meta.total, states: meta.functions, processedThisRun: meta.processed - startProcessed, disk: true })
	}
	try {
		while (meta.depth <= maximumDepth) {
			if (meta.depth !== startDepth) { startDepth = meta.depth; startProcessed = 0 }
			report()
			if (shouldPause?.()) return false
			const batch = await read<Entry>('SELECT id,state,mask,reads,gates FROM BuildFrontier WHERE depth=? ORDER BY id LIMIT ?', [meta.depth, options.readRows])
			if (!batch.length) {
				const next = meta.depth + 1
				const total = (await read<{ count: number }>('SELECT count(*) AS count FROM BuildFrontier WHERE depth=?', [next]))[0].count
				await run('UPDATE BuildMeta SET depth=?,processed=0,total=? WHERE id=1', [total ? next : maximumDepth + 1, total])
				meta.depth = total ? next : maximumDepth + 1
				meta.processed = 0; meta.total = total
				continue
			}
			const priorFunctions = meta.functions
			await run('BEGIN IMMEDIATE')
			try {
				const results = new Map<string, InputOutputReplacer>()
				let candidates: unknown[][] = []
				const flush = async () => {
					if (!candidates.length) return
					await timeWrite(() => insertRows(db, 'INSERT INTO BuildCandidates VALUES ', candidates, ' ON CONFLICT(state,mask) DO UPDATE SET reads=excluded.reads,gates=excluded.gates WHERE excluded.reads<BuildCandidates.reads', options.parameterLimit))
					candidates = []
				}
				for (const entry of batch) {
					const ioIdentifier = stateIdentifier(entry.state, wires)
					results.set(`${ioIdentifier}:${entry.mask}`, { ioIdentifier, replacerGates: decodeGates(entry.gates) })
				}
				if (meta.depth < maximumDepth) {
					for await (const expanded of expandBatch(batch, catalog.length, kernel, pool, { stageRows: options.stageRows, workers, queueBatches, minimumWork }, pending => { profile.peakPending = Math.max(profile.peakPending, pending) })) {
						const { result, parents, waitMs } = expanded
						profile.expansionMs += result.expansionMs; profile.waitMs += waitMs
						profile.candidates += result.attempts; profile.emitted += result.count
						const view = new DataView(result.candidates), stride = kernel.stateBytes + 16
						for (let i = 0; i < result.count; i++) {
							const offset = i * stride, parent = parents[view.getUint32(offset + kernel.stateBytes, true)], gate = view.getUint32(offset + kernel.stateBytes + 4, true)
							const state = Buffer.from(result.candidates, offset, kernel.stateBytes)
							candidates.push([state, view.getUint32(offset + kernel.stateBytes + 8, true), view.getUint32(offset + kernel.stateBytes + 12, true), Buffer.concat([parent.gates, encoded[gate]])])
							if (candidates.length >= options.stageRows) await flush()
						}
					}
				}
				await flush()
				if (meta.depth < maximumDepth && catalog.length) {
					// Deduplicate the complete read batch on disk before touching the global frontier.
					meta.functions += await run('INSERT INTO BuildSeen SELECT state,? FROM BuildCandidates GROUP BY state ON CONFLICT(state) DO NOTHING', [meta.depth + 1])
					if (options.stateLimit && meta.functions > options.stateLimit) throw new Error('Disk generation state limit reached; increase database.generationStates or set it to 0')
					await run('INSERT INTO BuildFrontier(state,mask,reads,gates,depth) SELECT c.state,c.mask,c.reads,c.gates,? FROM BuildCandidates c JOIN BuildSeen s ON c.state=s.state WHERE s.depth=? ON CONFLICT(state,mask) DO UPDATE SET reads=excluded.reads,gates=excluded.gates WHERE excluded.reads<BuildFrontier.reads', [meta.depth + 1, meta.depth + 1])
					await run('DELETE FROM BuildCandidates')
				}
				await timeWrite(() => store(results))
				await run('DELETE FROM BuildFrontier WHERE depth=? AND id<=?', [meta.depth, batch[batch.length - 1].id])
				await run('UPDATE BuildMeta SET processed=processed+?,functions=? WHERE id=1', [batch.length, meta.functions])
				await run('COMMIT')
				meta.processed += batch.length
				profile.batches++
			} catch (error) { meta.functions = priorFunctions; await run('ROLLBACK'); throw error }
		}
		if (!options.keepState) {
			await run('DROP TABLE BuildFrontier')
			await run('DROP TABLE BuildSeen')
		}
		return true
	} finally {
		await pool.close()
		profile.elapsedMs = performance.now() - started; profile.workersUsed = pool.workerCount
		options.onProfile?.({ ...profile })
	}
}
