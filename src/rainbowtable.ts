import { finalizeGeneration } from './generation-finalize.js'
import { generationLookupSchema, generationSignature } from './generation-storage.js'
import { LookupStatements } from './lookup-statements.js'
import { LookupBatcher } from './lookup-batcher.js'
import { join } from 'path'
import { availableParallelism } from 'os'
import { logVerbose } from './logging.js'
import sqlite3 from 'sqlite3'
import { config } from './config.js'
import { Gate } from './types.js'
import { decodeGates } from './semantic.js'
import { LimitedMap } from './limitedMap.js'
import { logTimed, hashGates } from './utils.js'
import { runSQL, allSQL } from './sql.js'
import { generateOnDisk } from './disk-generation.js'
import { GenerationEstimator, formatGenerationProgress, generationDuration, GenerationProfile, SemanticProgress, formatGenerationProfile } from './generation-progress.js'

export const databaseFilename = (wires: number, gates: number) => join(config.files.databaseDirectory, `rainbow_${wires}_${gates}.db`)
const keyToSql = (key: string) => Buffer.from(key, 'hex')
const rowKey = (key: Buffer) => key.toString('hex')
const readyDatabases = new WeakMap<sqlite3.Database, Promise<void>>()
export const databaseReady = (db: sqlite3.Database) => readyDatabases.get(db) ?? Promise.resolve()
export const getRainbowTable = (wires: number, gates: number) => {
	const db = new sqlite3.Database(databaseFilename(wires, gates))
	readyDatabases.set(db, new Promise<void>((resolve, reject) => {
		db.once('error', reject)
		db.run(`PRAGMA mmap_size=${config.database.memoryMapBytes}`, error => error ? reject(error) : resolve())
	}))
	return db
}
export const isEmpty = async (db: sqlite3.Database) => !(await allSQL(db, 'SELECT 1 FROM InputOutputReplacers LIMIT 1')).length


const lookupBatchers = new WeakMap<sqlite3.Database, LookupBatcher>()
const lookupStatements = new WeakMap<sqlite3.Database, LookupStatements>()
const closingLookups = new WeakSet<sqlite3.Database>()
const activeLookups = new WeakMap<sqlite3.Database, Set<Promise<unknown>>>()
export async function closeRainbowTable(db: sqlite3.Database) {
	closingLookups.add(db)
	await Promise.allSettled([...(activeLookups.get(db) ?? [])])
	await lookupStatements.get(db)?.close()
	await new Promise<void>((resolve, reject) => db.close(error => error ? reject(error) : resolve()))
}

/** Only complete builds with this exact canonical catalogue establish coverage. */
export async function hasCanonicalCoverage(db: sqlite3.Database, wires: number, gates: number) {
	try {
		const names = await allSQL<{ name: string }>(db, "SELECT name FROM sqlite_master WHERE type='table' AND name IN ('GenerationStatus','BuildMeta')")
		if (names.length !== 2) return false
		const status = await allSQL<{ complete: number }>(db, 'SELECT complete FROM GenerationStatus WHERE id=1')
		const meta = await allSQL<{ signature: string, depth: number }>(db, 'SELECT signature,depth FROM BuildMeta WHERE id=1')
		return status[0]?.complete === 1 && meta[0]?.depth > gates && meta[0]?.signature === generationSignature(wires, gates, hashGates([...generateAllGates(wires)]))
	} catch { return false }
}

const lookupReplacers = async (db: sqlite3.Database, cache: LimitedMap<string, Gate[] | null>, identifiers: string[], namespace: string) => {
	let batcher = lookupBatchers.get(db)
	if (!batcher) {
		batcher = new LookupBatcher(config.database.queryBatchSize, config.database.lookupBatchMilliseconds, async ids => {
			let statements = lookupStatements.get(db)
			if (!statements) { statements = new LookupStatements(db, config.database.statementCacheEntries); lookupStatements.set(db, statements) }
			const rows = await statements.query<{ ioIdentifier: Buffer, replacerGates: Buffer }>(ids.map(keyToSql))
			return new Map(rows.map(row => [rowKey(row.ioIdentifier), decodeGates(row.replacerGates)]))
		})
		lookupBatchers.set(db, batcher)
	}
	const resolved = await Promise.all([...new Set(identifiers)].map(async id => {
		const cacheKey = namespace + id
		let gates = cache.get(cacheKey)
		if (gates === undefined) { gates = await batcher!.get(id); cache.set(cacheKey, gates) }
		return gates === null ? undefined : { ioIdentifier: id, gates }
	}))
	return resolved.filter((entry): entry is { ioIdentifier: string, gates: Gate[] } => entry !== undefined)
}

export const getReplacersByIds = (db: sqlite3.Database, cache: LimitedMap<string, Gate[] | null>, identifiers: string[], namespace = '') => {
	if (closingLookups.has(db) && identifiers.some(id => cache.get(namespace + id) === undefined)) return Promise.reject(new Error('Rainbow lookup connection is closing'))
	const pending = lookupReplacers(db, cache, identifiers, namespace)
	let active = activeLookups.get(db)
	if (!active) { active = new Set(); activeLookups.set(db, active) }
	active.add(pending)
	const current = active
	pending.then(() => current.delete(pending), () => current.delete(pending))
	return pending
}

export const getReplacerById = async (db: sqlite3.Database, cache: LimitedMap<string, Gate[] | null>, id: string) => (await getReplacersByIds(db, cache, [id]))[0]?.gates ?? null

export function* generateAllGates(wires: number): Generator<Gate, undefined, unknown> {
	for (let gate_i = 0; gate_i < 16; gate_i++) {
		for (let target = 0; target < wires; target++) {
			switch (gate_i) {
				case 0: break //return false
				case 1: //return a && b
				case 2: //return a && !b
				case 4: //return !a && b
				case 6: //return xor(a, b)
				case 7: //return a || b
				case 8: //return !(a || b)
				case 9: //return (a && b) || (!a && !b)
				case 11: //return (!b) || a
				case 13: //return (!a) || b
				case 14: { //return !(a && b)
					for (let a = 0; a < wires; a++) {
						for (let b = a + 1; b < wires; b++) {
							if (a !== target && b !== target) yield { a, b, target, gate_i }
						}
					}
					break
				}
				case 10: //return !b
				case 5: { //return b
					for (let b = 0; b < wires; b++) {
						if (b !== target) yield { a: 0, b, target, gate_i }
					}
					break
				}
				case 12: //return !a
				case 3: { //return a
					for (let a = 0; a < wires; a++) {
						if (a !== target) yield { a, b: 0, target, gate_i }
					}
					break
				}
				case 15: { // return true
					yield { a: 0, b: 0, target, gate_i }
					break
				}
				default: throw new Error(`invalid control function: ${ gate_i }`)
			}
		}
	}
}



export const createRainbowTable = async (wires: number, gates: number) => {
	const db = getRainbowTable(wires, gates)
	await databaseReady(db)
	try {
		const columns = await allSQL<{ name: string }>(db, 'PRAGMA table_info(InputOutputReplacers)')
		const costColumns = ['gateCount', 'wireCount', 'readCount'].filter(name => columns.some(column => column.name === name))
		const catalog = [...generateAllGates(wires)]
		const hasMeta = (await allSQL(db, "SELECT name FROM sqlite_master WHERE name='BuildMeta'")).length > 0
		const meta = hasMeta ? (await allSQL<{ signature: string, depth: number }>(db, 'SELECT signature,depth FROM BuildMeta WHERE id=1'))[0] : undefined
		if (meta && meta.signature !== generationSignature(wires, gates, hashGates(catalog))) throw new Error('Incompatible generation checkpoint; keep it with its original version or use a fresh database directory')
		const finished = meta && meta.depth > gates
		if (columns.length && (costColumns.length !== 3 && !(costColumns.length === 0 && finished))) throw new Error('Incompatible rainbow schema. Keep the database and finish it with its original version, or select a fresh database directory; tables are not migrated.')
		await runSQL(db, generationLookupSchema)
		await runSQL(db, 'CREATE TABLE IF NOT EXISTS GenerationStatus(id INTEGER PRIMARY KEY,complete INTEGER NOT NULL)')
		const status = (await allSQL<{ complete: number }>(db, 'SELECT complete FROM GenerationStatus WHERE id=1'))[0]?.complete
		if (finished) {
			if (status !== 1 || costColumns.length) {
				const finishing = () => logTimed('Rainbow generation: 99.99% complete | ETA finishing')
				finishing()
				const timer = setInterval(finishing, config.timing.databaseLogSeconds * 1000)
				try { await finalizeGeneration(db) } finally { clearInterval(timer) }
				logTimed('Rainbow generation: 100.00% complete | ETA 0s')
			}
			logTimed(`Using rainbow table ${databaseFilename(wires, gates)}`)
			return db
		}
		if (status === 1 || status === 2) throw new Error('Rainbow completion metadata is inconsistent')
		await configureGenerationDatabase(db)
		await runSQL(db, 'INSERT OR REPLACE INTO GenerationStatus VALUES(1,0)')
		logTimed(`Generating rainbow table: ${wires} wires, up to ${gates} gates, ${catalog.length} gate choices`)
		const started = performance.now(), estimator = new GenerationEstimator(config.database.etaWindowSamples, config.database.etaWarmupSamples, config.database.etaSmoothing, config.database.etaMaximumSlowdown)
		let lastReport = started, current: SemanticProgress | undefined
		let profile: GenerationProfile | undefined
		const workers = Math.min(config.database.generationWorkers, Math.max(1, availableParallelism() - 1))
		logTimed(`Generation expansion: up to ${workers} CPU slots; batches below ${config.database.generationMinimumWork.toLocaleString('en-US')} candidates run inline; one database writer`)
		const report = (force = false) => {
			const now = performance.now()
			if (!force && now - lastReport < config.timing.databaseLogSeconds * 1000) return
			lastReport = now
			if (current) estimator.update(current, now)
			logTimed(formatGenerationProgress(current, now - started, current ? estimator.overallEta(current) : 'learning processing speed'))
			if (profile) logVerbose(formatGenerationProfile(profile, now))
		}
		report(true)
		const timer = setInterval(() => report(), config.timing.databaseLogSeconds * 1000)
		try {
			await generateOnDisk(db, wires, gates, catalog, {
				readRows: config.database.generationReadRows, stageRows: config.database.generationBatchRows,
				parameterLimit: config.database.generationSqlParameters, preparedInserts: config.database.generationPreparedInserts, sortStaging: config.database.generationSortStaging, statementCacheEntries: config.database.generationStatementCacheEntries, stateLimit: config.database.generationStates,
				keepState: true,
				workers, queueBatches: config.database.generationQueueBatches, minimumWork: config.database.generationMinimumWork,
				onProfile: value => { profile = value },
			}, progress => {
				const newLayer = current?.depth !== progress.depth
				current = { ...progress, complete: false }
				report(newLayer)
			})
			await finalizeGeneration(db, phase => { if (profile) profile = { ...profile, phase, phaseStarted: performance.now() } })
			if (current) current.complete = true
			report(true)
			logTimed(`Rainbow generation complete in ${generationDuration(performance.now() - started)}.`)
			if (profile) logVerbose(`Generation profile: ${profile.workersUsed} CPU threads started; ${profile.candidates} candidates expanded, ${profile.emitted} emitted after local deduplication; ${(profile.expansionMs / 1000).toFixed(2)} expansion worker-seconds; ${((profile.writeMs + profile.readMs) / 1000).toFixed(2)}s database work; ${(profile.waitMs / 1000).toFixed(2)}s waiting for expansion; peak ${profile.peakPending} pending tasks. Times can overlap.`)
		} finally { clearInterval(timer) }
		return db
	} catch (error) { await new Promise<void>(resolve => db.close(() => resolve())); throw error }
}

/** Explicit, bounded build tuning; lookup connections keep their own settings. */
export async function configureGenerationDatabase(db: sqlite3.Database) {
	await runSQL(db, `PRAGMA journal_mode=${config.database.generationJournalMode === 'wal' ? 'WAL' : 'DELETE'}`)
	await runSQL(db, `PRAGMA synchronous=${config.database.generationSynchronous === 'full' ? 'FULL' : 'NORMAL'}`)
	await runSQL(db, `PRAGMA cache_size=-${config.database.generationCacheMegabytes * 1024}`)
	await runSQL(db, `PRAGMA temp.cache_size=-${config.database.generationCacheMegabytes * 1024}`)
	await runSQL(db, `PRAGMA temp_store=${config.database.generationTempStore === 'file' ? 'FILE' : 'MEMORY'}`)
}
