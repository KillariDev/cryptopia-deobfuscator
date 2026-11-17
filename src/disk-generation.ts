import { frontierCandidatesSQL, countNewFinalFunctionsSQL } from './generation-dedup.js'
import sqlite3 from 'sqlite3'
import { Gate } from './types.js'
import { circuitState, encodeGates } from './semantic.js'
import { hashGates } from './utils.js'
import { runSQL, allSQL, insertRows } from './sql.js'
import { overallGenerationWork, GenerationProfile, SemanticProgress } from './generation-progress.js'
import { ExpansionKernel } from './generation-expansion.js'
import { GenerationPool } from './generation-pool.js'
import { expandBatch } from './generation-pipeline.js'
import { generationSignature, packState, unpackState, usedWires } from './generation-storage.js'

type Meta = { signature: string, depth: number, processed: number, total: number, functions: number }
type Entry = { id: number, state: Buffer, mask: number, reads: number, gates: Buffer }
export type DiskGenerationOptions = { readRows: number, stageRows: number, parameterLimit: number, stateLimit: number, keepState: boolean, workers?: number, queueBatches?: number, minimumWork?: number, onProfile?: (profile: GenerationProfile) => void, beforeCommit?: () => Promise<void> }

const better = 'excluded.gateCount<InputOutputReplacers.gateCount OR (excluded.gateCount=InputOutputReplacers.gateCount AND (excluded.wireCount<InputOutputReplacers.wireCount OR (excluded.wireCount=InputOutputReplacers.wireCount AND excluded.readCount<InputOutputReplacers.readCount)))'
// Rank exactly as isReplacementSimpler: gate count, distinct used wires, reads.
const merge = `INSERT INTO InputOutputReplacers(ioIdentifier,replacerGates,gateCount,wireCount,readCount)
 SELECT state,gates,?,wires,reads FROM (
 SELECT state,gates,wires,reads,ROW_NUMBER() OVER (PARTITION BY state ORDER BY wires,reads,mask) AS preference FROM BuildCandidates
 ) WHERE preference=1 ON CONFLICT(ioIdentifier) DO UPDATE SET replacerGates=excluded.replacerGates,gateCount=excluded.gateCount,wireCount=excluded.wireCount,readCount=excluded.readCount WHERE ${better}`

/** A transaction commits output, discovered states and input consumption together. */
export async function generateOnDisk(db: sqlite3.Database, wires: number, maximumDepth: number, catalog: Gate[], options: DiskGenerationOptions,
	onProgress?: (progress: SemanticProgress) => void, shouldPause?: () => boolean) {
	if (!Number.isInteger(wires) || wires < 1 || wires > 8 || !Number.isSafeInteger(maximumDepth) || maximumDepth < 1) throw new Error('Invalid generation wire/depth limits')
	const workers = options.workers ?? 1, queueBatches = options.queueBatches ?? 2, minimumWork = options.minimumWork ?? 100000
	for (const value of [workers, queueBatches, minimumWork, options.readRows, options.stageRows, options.parameterLimit]) if (!Number.isSafeInteger(value) || value < 1) throw new Error('Invalid generation pipeline limits')
	const signature = generationSignature(wires, maximumDepth, hashGates(catalog))
	// Check before any schema/data mutation: older unfinished builds are never migrated.
	const hasMeta = (await allSQL(db, "SELECT name FROM sqlite_master WHERE name='BuildMeta'")).length > 0
	let meta = hasMeta ? (await allSQL<Meta>(db, 'SELECT * FROM BuildMeta WHERE id=1'))[0] : undefined
	if (meta && meta.signature !== signature) throw new Error('Incompatible generation checkpoint. Keep this database and finish it with the version that created it, or use a different database directory for a fresh build.')
	const columns = await allSQL<{ name: string }>(db, 'PRAGMA table_info(InputOutputReplacers)')
	if (!['gateCount', 'wireCount', 'readCount'].every(name => columns.some(column => column.name === name))) throw new Error('Incompatible rainbow schema; use a fresh database directory. Existing tables are not migrated.')
	const started = performance.now()
	const profile: GenerationProfile = { elapsedMs: 0, expansionMs: 0, writeMs: 0, readMs: 0, waitMs: 0, stagingMs: 0, dedupMs: 0, outputMs: 0, commitMs: 0, phase: 'reading', phaseStarted: started, candidates: 0, emitted: 0, batches: 0, workersUsed: 0, peakPending: 0 }
	const phase = async <T>(name: GenerationProfile['phase'], operation: () => Promise<T>): Promise<T> => {
		profile.phase = name; profile.phaseStarted = performance.now(); options.onProfile?.({ ...profile })
		try { return await operation() } finally {
			const elapsed = performance.now() - profile.phaseStarted
			if (name === 'reading') profile.readMs += elapsed
			else if (name === 'staging') profile.stagingMs += elapsed
			else if (name === 'deduplicating') profile.dedupMs += elapsed
			else if (name === 'writing lookup') profile.outputMs += elapsed
			else if (name === 'committing') profile.commitMs += elapsed
			profile.writeMs = profile.stagingMs + profile.dedupMs + profile.outputMs + profile.commitMs
		}
	}
	const run = (sql: string, params: unknown[] = []) => runSQL(db, sql, params)
	await run('CREATE TABLE IF NOT EXISTS BuildMeta (id INTEGER PRIMARY KEY, signature TEXT NOT NULL, depth INTEGER NOT NULL, processed INTEGER NOT NULL, total INTEGER NOT NULL, functions INTEGER NOT NULL)')
	await run('CREATE TABLE IF NOT EXISTS BuildSeen (state BLOB PRIMARY KEY, depth INTEGER NOT NULL) WITHOUT ROWID')
	await run('CREATE TABLE IF NOT EXISTS BuildFrontier (id INTEGER PRIMARY KEY, state BLOB NOT NULL, mask INTEGER NOT NULL, reads INTEGER NOT NULL, gates BLOB NOT NULL, depth INTEGER NOT NULL, UNIQUE(state,mask))')
	await run('CREATE INDEX IF NOT EXISTS BuildFrontierDepth ON BuildFrontier(depth,id)')
	await run('CREATE TABLE IF NOT EXISTS BuildLayers (depth INTEGER PRIMARY KEY,total INTEGER NOT NULL,processed INTEGER NOT NULL)')
	await run('CREATE TEMP TABLE IF NOT EXISTS BuildCandidates (state BLOB NOT NULL, mask INTEGER NOT NULL, reads INTEGER NOT NULL, gates BLOB NOT NULL, wires INTEGER NOT NULL, PRIMARY KEY(state,mask)) WITHOUT ROWID')
	if (!meta) {
		const identity = packState(circuitState([], wires), wires)
		await run('BEGIN IMMEDIATE')
		try {
			await run('INSERT INTO BuildSeen VALUES (?,0)', [identity])
			await run('INSERT INTO BuildFrontier(state,mask,reads,gates,depth) VALUES (?,0,0,?,0)', [identity, Buffer.alloc(0)])
			await run('INSERT INTO BuildMeta VALUES (1,?,0,0,1,1)', [signature])
			await run('INSERT INTO BuildLayers VALUES (0,1,0)')
			await run('COMMIT')
		} catch (error) { await run('ROLLBACK'); throw error }
		meta = { signature, depth: 0, processed: 0, total: 1, functions: 1 }
	}
	const encoded = catalog.map(gate => encodeGates([gate])), kernel = new ExpansionKernel(wires, catalog), pool = new GenerationPool(workers, wires, catalog)
	const layers = await allSQL<{ depth: number, total: number, processed: number }>(db, 'SELECT * FROM BuildLayers ORDER BY depth')
	let startDepth = meta.depth, startProcessed = meta.processed
	const report = () => {
		profile.elapsedMs = performance.now() - started; profile.workersUsed = pool.workerCount
		options.onProfile?.({ ...profile })
		onProgress?.({ depth: meta!.depth, processed: meta!.processed, total: meta!.total, states: meta!.functions, complete: profile.phase === 'complete', ...overallGenerationWork(layers, maximumDepth, meta!.depth > maximumDepth, catalog.length), processedThisRun: meta!.processed - startProcessed, disk: true })
	}
	try {
		// The last expanded layer writes directly to output: no depth-maximum frontier.
		while (meta.depth < maximumDepth) {
			if (meta.depth !== startDepth) { startDepth = meta.depth; startProcessed = 0 }
			report()
			if (shouldPause?.()) return false
			const batch = await phase('reading', () => allSQL<Entry>(db, 'SELECT id,state,mask,reads,gates FROM BuildFrontier WHERE depth=? ORDER BY id LIMIT ?', [meta!.depth, options.readRows]))
			if (!batch.length) {
				const next = meta.depth + 1
				const total = next < maximumDepth ? (await phase('reading', () => allSQL<{ count: number }>(db, 'SELECT count(*) AS count FROM BuildFrontier WHERE depth=?', [next])))[0].count : 0
				await run('BEGIN IMMEDIATE')
				try {
					await run('UPDATE BuildMeta SET depth=?,processed=0,total=? WHERE id=1', [total ? next : maximumDepth + 1, total])
					if (total) await run('INSERT INTO BuildLayers VALUES (?,?,0)', [next, total])
					await run('COMMIT')
				} catch (error) { await run('ROLLBACK'); throw error }
				if (total) layers.push({ depth: next, total, processed: 0 })
				meta.depth = total ? next : maximumDepth + 1; meta.processed = 0; meta.total = total
				continue
			}
			const priorFunctions = meta.functions
			await run('BEGIN IMMEDIATE')
			try {
				// Merge the input layer in bulk using the same exact cost ordering.
				await phase('staging', () => insertRows(db, 'INSERT INTO BuildCandidates VALUES ', batch.map(entry => [entry.state, entry.mask, entry.reads, entry.gates, usedWires(entry.mask)]), '', options.parameterLimit))
				await phase('writing lookup', () => run(merge, [meta!.depth]))
				await phase('staging', () => run('DELETE FROM BuildCandidates'))
				const parents = batch.map(entry => ({ ...entry, state: unpackState(entry.state, wires) }))
				let candidates: unknown[][] = []
				const flush = async () => {
					if (!candidates.length) return
					await phase('staging', () => insertRows(db, 'INSERT INTO BuildCandidates VALUES ', candidates, ' ON CONFLICT(state,mask) DO UPDATE SET reads=excluded.reads,gates=excluded.gates WHERE excluded.reads<BuildCandidates.reads', options.parameterLimit))
					candidates = []
				}
				const expanding = () => { profile.phase = 'expanding'; profile.phaseStarted = performance.now(); options.onProfile?.({ ...profile }) }
				expanding()
				for await (const expanded of expandBatch(parents, catalog.length, kernel, pool, { stageRows: options.stageRows, workers, queueBatches, minimumWork }, pending => { profile.peakPending = Math.max(profile.peakPending, pending) })) {
					const { result, parents: chunk, waitMs } = expanded
					profile.expansionMs += result.expansionMs; profile.waitMs += waitMs
					profile.candidates += result.attempts; profile.emitted += result.count
					profile.phase = 'expanding'; profile.phaseStarted = performance.now(); options.onProfile?.({ ...profile })
					const view = new DataView(result.candidates), stride = kernel.stateBytes + 16
					for (let i = 0; i < result.count; i++) {
						const offset = i * stride, parent = chunk[view.getUint32(offset + kernel.stateBytes, true)], gate = view.getUint32(offset + kernel.stateBytes + 4, true)
						const mask = view.getUint32(offset + kernel.stateBytes + 8, true)
						candidates.push([packState(new Uint8Array(result.candidates, offset, kernel.stateBytes), wires), mask, view.getUint32(offset + kernel.stateBytes + 12, true), Buffer.concat([parent.gates, encoded[gate]]), usedWires(mask)])
						if (candidates.length >= options.stageRows) await flush()
					}
					expanding()
				}
				await flush()
				const final = meta.depth + 1 === maximumDepth
				await phase('deduplicating', async () => {
					if (final) {
						meta!.functions += (await allSQL<{ count: number }>(db, countNewFinalFunctionsSQL))[0].count
					} else {
						meta!.functions += await run('INSERT INTO BuildSeen SELECT state,? FROM BuildCandidates GROUP BY state ON CONFLICT(state) DO NOTHING', [meta!.depth + 1])
						// CROSS JOIN keeps the bounded batch outside the primary-key probe; ordinary JOIN scans all BuildSeen.
						await run('INSERT INTO BuildFrontier(state,mask,reads,gates,depth) ' + frontierCandidatesSQL + ' ON CONFLICT(state,mask) DO UPDATE SET reads=excluded.reads,gates=excluded.gates WHERE excluded.reads<BuildFrontier.reads', [meta!.depth + 1, meta!.depth + 1])
					}
					if (options.stateLimit && meta!.functions > options.stateLimit) throw new Error('Disk generation state limit reached; increase database.generationStates or set it to 0')
				})
				if (final) await phase('writing lookup', () => run(merge, [maximumDepth]))
				await phase('staging', () => run('DELETE FROM BuildCandidates'))
				await phase('deduplicating', async () => {
					await run('DELETE FROM BuildFrontier WHERE depth=? AND id<=?', [meta!.depth, batch[batch.length - 1].id])
					await run('UPDATE BuildMeta SET processed=processed+?,functions=? WHERE id=1', [batch.length, meta!.functions])
					await run('UPDATE BuildLayers SET processed=processed+? WHERE depth=?', [batch.length, meta!.depth])
				})
				await options.beforeCommit?.()
				await phase('committing', () => run('COMMIT'))
				meta.processed += batch.length; layers.find(layer => layer.depth === meta!.depth)!.processed += batch.length; profile.batches++
			} catch (error) { meta.functions = priorFunctions; await run('ROLLBACK'); throw error }
		}
		if (!options.keepState) { await run('DROP TABLE BuildFrontier'); await run('DROP TABLE BuildSeen') }
		profile.phase = 'complete'; report()
		return true
	} finally {
		await pool.close(); profile.elapsedMs = performance.now() - started; profile.workersUsed = pool.workerCount
		options.onProfile?.({ ...profile })
	}
}
