import { WriterUtilization } from './generation-utilization.js'
import { GenerationPrefetch, GenerationActivity } from './generation-prefetch.js'
import { ShardedStagingWriter } from './generation-shards.js'
import { logVerbose } from './logging.js'
import { candidateMergeSQL } from './generation-merge.js'
import { StagingWriter, StagingRow } from './generation-staging.js'
import { frontierCandidatesSQL, countNewFinalFunctionsSQL } from './generation-dedup.js'
import sqlite3 from 'sqlite3'
import { Gate } from './types.js'
import { circuitState, encodeGates } from './semantic.js'
import { hashGates } from './utils.js'
import { runSQL, allSQL } from './sql.js'
import { overallGenerationWork, GenerationProfile, SemanticProgress } from './generation-progress.js'
import { ExpansionKernel } from './generation-expansion.js'
import { GenerationPool } from './generation-pool.js'
import { expandBatch, ExpansionChunk } from './generation-pipeline.js'
import { generationSignature, packState, unpackState, usedWires } from './generation-storage.js'

type Meta = { signature: string, depth: number, processed: number, total: number, functions: number }
type Parent = Omit<Entry, 'state'> & { state: Uint8Array }
type PreparedBatch = { batch: Entry[], depth: number, expansion?: GenerationPrefetch<ExpansionChunk<Parent>> }
type Entry = { id: number, state: Buffer, mask: number, reads: number, gates: Buffer }
export type DiskGenerationOptions = { readRows: number, stageRows: number, parameterLimit: number, stateLimit: number, keepState: boolean, workers?: number, queueBatches?: number, minimumWork?: number, preparedInserts?: boolean, sortStaging?: boolean, statementCacheEntries?: number, appendStaging?: boolean, compactBindings?: boolean, stagingWriters?: number, stagingDirectory?: string, stagingCacheMegabytes?: number, aggregateMerge?: boolean, directInputMerge?: boolean, prefetch?: boolean, prefetchMegabytes?: number, onActivity?: (read: () => GenerationActivity) => void, onProfile?: (profile: GenerationProfile) => void, beforeCommit?: () => Promise<void> }

/** A transaction commits output, discovered states and input consumption together. */
export async function generateOnDisk(db: sqlite3.Database, wires: number, maximumDepth: number, catalog: Gate[], options: DiskGenerationOptions,
	onProgress?: (progress: SemanticProgress) => void, shouldPause?: () => boolean) {
	if (!Number.isInteger(wires) || wires < 1 || wires > 8 || !Number.isSafeInteger(maximumDepth) || maximumDepth < 1) throw new Error('Invalid generation wire/depth limits')
	const workers = options.workers ?? 1, queueBatches = options.queueBatches ?? 2, minimumWork = options.minimumWork ?? 100000
	for (const value of [workers, queueBatches, minimumWork, options.readRows, options.stageRows, options.parameterLimit]) if (!Number.isSafeInteger(value) || value < 1) throw new Error('Invalid generation pipeline limits')
	const stagingWriters = options.stagingWriters ?? 1
	if (![1, 2, 4].includes(stagingWriters) || (stagingWriters > 1 && options.appendStaging)) throw new Error('Choose 1, 2 or 4 staging writers; parallel writers require indexed staging')
	const signature = generationSignature(wires, maximumDepth, hashGates(catalog))
	// Check before any schema/data mutation: older unfinished builds are never migrated.
	const hasMeta = (await allSQL(db, "SELECT name FROM sqlite_master WHERE name='BuildMeta'")).length > 0
	let meta = hasMeta ? (await allSQL<Meta>(db, 'SELECT * FROM BuildMeta WHERE id=1'))[0] : undefined
	if (meta && meta.signature !== signature) throw new Error('Incompatible generation checkpoint. Keep this database and finish it with the version that created it, or use a different database directory for a fresh build.')
	const columns = await allSQL<{ name: string }>(db, 'PRAGMA table_info(InputOutputReplacers)')
	if (!['gateCount', 'wireCount', 'readCount'].every(name => columns.some(column => column.name === name))) throw new Error('Incompatible rainbow schema; use a fresh database directory. Existing tables are not migrated.')
	const started = performance.now()
	const profile: GenerationProfile = { elapsedMs: 0, expansionMs: 0, writeMs: 0, readMs: 0, waitMs: 0, stagingMs: 0, dedupMs: 0, outputMs: 0, commitMs: 0, importMs: 0, committedParents: 0, phaseActive: false, phase: 'reading', phaseStarted: started, candidates: 0, emitted: 0, batches: 0, workersUsed: 0, peakPending: 0 }
	const phase = async <T>(name: GenerationProfile['phase'], operation: () => Promise<T>): Promise<T> => {
		profile.phase = name; profile.phaseActive = true; profile.phaseStarted = performance.now(); options.onProfile?.({ ...profile })
		try { return await operation() } finally {
			const elapsed = performance.now() - profile.phaseStarted
			if (name === 'reading') profile.readMs += elapsed
			else if (name === 'staging') profile.stagingMs += elapsed
			else if (name === 'deduplicating') profile.dedupMs += elapsed
			else if (name === 'writing lookup') profile.outputMs += elapsed
			else if (name === 'committing') profile.commitMs += elapsed
			else if (name === 'importing scratch') profile.importMs += elapsed
			profile.writeMs = profile.stagingMs + profile.dedupMs + profile.outputMs + profile.commitMs + profile.importMs
			profile.phaseActive = false; options.onProfile?.({ ...profile })
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
	const stagingOptions = { parameterLimit: options.parameterLimit, cacheEntries: options.statementCacheEntries ?? 8, prepared: options.preparedInserts ?? true, sort: options.sortStaging ?? false, append: options.appendStaging ?? false, compactBindings: options.compactBindings ?? false }
	const staging = await StagingWriter.create(db, stagingOptions)
	let shards: ShardedStagingWriter | undefined
	const singleWriter = new WriterUtilization(1)
	const budget = (options.prefetchMegabytes ?? 16) * 1048576
	if (!Number.isSafeInteger(budget) || budget < 1) throw new Error('Invalid generation lookahead budget')
	const prefetchEnabled = (options.prefetch ?? false) && workers > 1
	let queued: PreparedBatch | undefined, consuming: PreparedBatch | undefined
	const parentsOf = (batch: Entry[]): Parent[] => batch.map(entry => ({ ...entry, state: unpackState(entry.state, wires) }))
	const expand = (parents: Parent[]) => expandBatch(parents, catalog.length, kernel, pool, { stageRows: options.stageRows, workers, queueBatches, minimumWork }, pending => { profile.peakPending = Math.max(profile.peakPending, pending) })
	options.onActivity?.(() => ({ ...pool.activity, lookaheadBatches: queued ? 1 : 0, bufferedBytes: (queued?.expansion?.bufferedBytes ?? 0) + (consuming?.expansion?.bufferedBytes ?? 0), bufferLimitBytes: prefetchEnabled ? budget * 2 : 0, ...(shards?.activity ?? { ...singleWriter.snapshot(), stagingWriters: 1, activeStagingWriters: singleWriter.activeCount }) }))
	let failed = false
	let startDepth = meta.depth, startProcessed = meta.processed
	const report = () => {
		profile.elapsedMs = performance.now() - started; profile.workersUsed = pool.workerCount
		options.onProfile?.({ ...profile })
		onProgress?.({ depth: meta!.depth, processed: meta!.processed, total: meta!.total, states: meta!.functions, complete: profile.phase === 'complete', ...overallGenerationWork(layers, maximumDepth, meta!.depth > maximumDepth, catalog.length), processedThisRun: meta!.processed - startProcessed, disk: true })
	}
	try {
		if (stagingWriters > 1) shards = await ShardedStagingWriter.create(db, { ...stagingOptions, writers: stagingWriters, directory: options.stagingDirectory, cacheMegabytes: options.stagingCacheMegabytes ?? 64 })
		logVerbose(`Generation staging: ${stagingWriters} writer(s), ${options.compactBindings ? 3 : 5} bindings per candidate${shards ? `; disposable scratch databases: ${shards.directory}` : ''}`)
		// The last expanded layer writes directly to output: no depth-maximum frontier.
		while (meta.depth < maximumDepth) {
			if (meta.depth !== startDepth) { startDepth = meta.depth; startProcessed = 0 }
			report()
			if (shouldPause?.()) return false
			consuming = queued; queued = undefined
			if (consuming && consuming.depth !== meta.depth) throw new Error('Lookahead crossed a generation depth boundary')
			const batch = consuming?.batch ?? await phase('reading', () => allSQL<Entry>(db, 'SELECT id,state,mask,reads,gates FROM BuildFrontier WHERE depth=? ORDER BY id LIMIT ?', [meta!.depth, options.readRows]))
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
			if (shards) await phase('staging', () => shards!.beginBatch())
			// IMMEDIATE would reserve write locks on attached scratch databases,
			// blocking their independent connections. Only main is authoritative.
			await run(shards ? 'BEGIN' : 'BEGIN IMMEDIATE')
			try {
				if (prefetchEnabled) {
					// Current-depth rows after this prefix cannot be changed by expansion,
					// which only writes the next depth. Never speculate across the barrier.
					const upcoming = await phase('reading', () => allSQL<Entry>(db, 'SELECT id,state,mask,reads,gates FROM BuildFrontier INDEXED BY BuildFrontierDepth WHERE depth=? AND id>? ORDER BY id LIMIT ?', [meta!.depth, batch[batch.length - 1].id, options.readRows]))
					if (upcoming.length) {
						queued = { batch: upcoming, depth: meta.depth }
						if (upcoming.length * catalog.length >= minimumWork) queued.expansion = new GenerationPrefetch(expand(parentsOf(upcoming)), budget, value => value.result.candidates.byteLength)
					}
				}
				if (options.directInputMerge ?? true) {
					// The read batch is the remaining depth prefix through its last id.
					await phase('writing lookup', () => run(candidateMergeSQL(options.aggregateMerge ?? true, true), [meta!.depth, meta!.depth, batch[batch.length - 1].id]))
				} else {
					await phase('staging', () => singleWriter.measure(() => staging.write(batch.map<StagingRow>(entry => [entry.state, entry.mask, entry.reads, entry.gates, usedWires(entry.mask)]))))
					await phase('deduplicating', () => singleWriter.measure(() => staging.materialize()))
					await phase('writing lookup', () => run(candidateMergeSQL(options.aggregateMerge ?? true), [meta!.depth]))
					await phase('staging', () => run('DELETE FROM BuildCandidates'))
				}
				const parents = consuming?.expansion ? undefined : parentsOf(batch)
				let candidates: StagingRow[] = []
				const flush = async () => {
					if (!candidates.length) return
					await phase('staging', () => shards ? shards.write(candidates) : singleWriter.measure(() => staging.write(candidates)))
					candidates = []
				}
				const expanding = () => { profile.phase = 'expanding'; profile.phaseActive = true; profile.phaseStarted = performance.now(); options.onProfile?.({ ...profile }) }
				expanding()
				for await (const expanded of (consuming?.expansion?.values() ?? expand(parents!))) {
					const { result, parents: chunk, waitMs } = expanded
					profile.expansionMs += result.expansionMs; profile.waitMs += waitMs
					profile.candidates += result.attempts; profile.emitted += result.count
					profile.phase = 'expanding'; profile.phaseActive = true; profile.phaseStarted = performance.now(); options.onProfile?.({ ...profile })
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
				if (shards) {
					await phase('staging', () => shards!.materialize())
					await phase('importing scratch', () => shards!.importBatch())
				} else await phase('deduplicating', () => singleWriter.measure(() => staging.materialize()))
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
				if (final) await phase('writing lookup', () => run(candidateMergeSQL(options.aggregateMerge ?? true), [maximumDepth]))
				await phase('staging', () => run('DELETE FROM BuildCandidates'))
				await phase('deduplicating', async () => {
					await run('DELETE FROM BuildFrontier WHERE depth=? AND id<=?', [meta!.depth, batch[batch.length - 1].id])
					await run('UPDATE BuildMeta SET processed=processed+?,functions=? WHERE id=1', [batch.length, meta!.functions])
					await run('UPDATE BuildLayers SET processed=processed+? WHERE depth=?', [batch.length, meta!.depth])
				})
				await options.beforeCommit?.()
				await phase('committing', () => run('COMMIT'))
				profile.committedParents += batch.length;
				meta.processed += batch.length; layers.find(layer => layer.depth === meta!.depth)!.processed += batch.length; profile.batches++
			} catch (error) { meta.functions = priorFunctions; await run('ROLLBACK'); throw error }
		}
		if (!options.keepState) { await run('DROP TABLE BuildFrontier'); await run('DROP TABLE BuildSeen') }
		profile.phase = 'complete'; profile.phaseActive = false; report()
		return true
	} catch (error) { failed = true; throw error } finally {
		queued?.expansion?.cancel(); consuming?.expansion?.cancel()
		const cleanup = await Promise.allSettled([shards?.close(), staging.close(), pool.close()])
		await Promise.allSettled([queued?.expansion?.settled, consuming?.expansion?.settled])
		if (!failed) for (const result of cleanup) if (result.status === 'rejected') throw result.reason
		profile.elapsedMs = performance.now() - started; profile.workersUsed = pool.workerCount
		options.onProfile?.({ ...profile })
	}
}
