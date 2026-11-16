import { join } from 'path'
import sqlite3 from 'sqlite3'
import { config } from './config.js'
import { Gate, InputOutputReplacer } from './types.js'
import { encodeGates, decodeGates } from './semantic.js'
import { LimitedMap } from './limitedMap.js'
import { isReplacementSimpler, logTimed } from './utils.js'
import { runSQL, allSQL, insertRows } from './sql.js'
import { generateOnDisk } from './disk-generation.js'
import { GenerationEstimator, formatGenerationProgress, generationDuration, SemanticProgress } from './generation-progress.js'

export const RAINBOW_TABLE_WIRES = config.database.wires
export const RAINBOW_TABLE_GATES = config.database.gates
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

export const storeReplacers = async (db: sqlite3.Database, replacers: Map<string, InputOutputReplacer>, withinTransaction = false) => {
	const best = new Map<string, Gate[]>()
	for (const { ioIdentifier, replacerGates } of replacers.values()) {
		const prior = best.get(ioIdentifier)
		if (!prior || isReplacementSimpler(replacerGates, prior)) best.set(ioIdentifier, replacerGates)
	}
	const ids = [...best.keys()]
	for (let offset = 0; offset < ids.length; offset += config.database.insertBatchSize) {
		const transactionIds = ids.slice(offset, offset + config.database.insertBatchSize)
		if (!withinTransaction) await runSQL(db, 'BEGIN IMMEDIATE')
		try {
			const existing = new Map<string, Gate[]>()
			for (let i = 0; i < transactionIds.length; i += config.database.queryBatchSize) {
				const chunk = transactionIds.slice(i, i + config.database.queryBatchSize)
				const rows = await allSQL<{ ioIdentifier: Buffer, replacerGates: Buffer }>(db, 'SELECT ioIdentifier,replacerGates FROM InputOutputReplacers WHERE ioIdentifier IN (' + chunk.map(() => '?').join(',') + ')', chunk.map(keyToSql))
				for (const row of rows) existing.set(rowKey(row.ioIdentifier), decodeGates(row.replacerGates))
			}
			const inserts: unknown[][] = []
			for (const id of transactionIds) {
				const gates = best.get(id)!
				if (!existing.has(id) || isReplacementSimpler(gates, existing.get(id)!)) inserts.push([keyToSql(id), encodeGates(gates)])
			}
			await insertRows(db, 'INSERT OR REPLACE INTO InputOutputReplacers VALUES ', inserts, '', config.database.queryBatchSize)
			if (!withinTransaction) await runSQL(db, 'COMMIT')
		} catch (error) { if (!withinTransaction) await runSQL(db, 'ROLLBACK'); throw error }
	}
}


export const getReplacersByIds = async (db: sqlite3.Database, cache: LimitedMap<string, Gate[] | null>, identifiers: string[]) => {
	const results: { ioIdentifier: string, gates: Gate[] }[] = []
	const missing: string[] = []
	for (const id of new Set(identifiers)) {
		const hit = cache.get(id)
		if (hit === undefined) missing.push(id)
		else if (hit !== null) results.push({ ioIdentifier: id, gates: hit })
	}
	for (let i = 0; i < missing.length; i += config.database.queryBatchSize) {
		const chunk = missing.slice(i, i + config.database.queryBatchSize)
		const rows = await allSQL<{ ioIdentifier: Buffer, replacerGates: Buffer }>(db, 'SELECT ioIdentifier,replacerGates FROM InputOutputReplacers WHERE ioIdentifier IN (' + chunk.map(() => '?').join(',') + ')', chunk.map(keyToSql))
		const found = new Set<string>()
		for (const row of rows) {
			const id = rowKey(row.ioIdentifier), gates = decodeGates(row.replacerGates)
			found.add(id); cache.set(id, gates); results.push({ ioIdentifier: id, gates })
		}
		for (const id of chunk) if (!found.has(id)) cache.set(id, null)
	}
	return results
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
		await runSQL(db, 'CREATE TABLE IF NOT EXISTS InputOutputReplacers(ioIdentifier BLOB PRIMARY KEY,replacerGates BLOB NOT NULL) WITHOUT ROWID')
		await runSQL(db, 'CREATE TABLE IF NOT EXISTS GenerationStatus(id INTEGER PRIMARY KEY,complete INTEGER NOT NULL)')
		if ((await allSQL<{ complete: number }>(db, 'SELECT complete FROM GenerationStatus WHERE id=1'))[0]?.complete === 1) {
			logTimed(`Using rainbow table ${databaseFilename(wires, gates)}`)
			return db
		}
		await runSQL(db, 'INSERT OR REPLACE INTO GenerationStatus VALUES(1,0)')
		const catalog = [...generateAllGates(wires)]
		logTimed(`Generating rainbow table: ${wires} wires, up to ${gates} gates, ${catalog.length} gate choices`)
		const started = performance.now(), estimator = new GenerationEstimator(config.database.etaWindowSamples, config.database.etaWarmupSamples, config.database.etaSmoothing)
		let lastReport = started, current: SemanticProgress | undefined
		const report = (force = false) => {
			const now = performance.now()
			if (!force && now - lastReport < config.timing.databaseLogSeconds * 1000) return
			lastReport = now
			logTimed(formatGenerationProgress(current, now - started, current ? estimator.update(current, now) : 'learning processing speed'))
		}
		report(true)
		const timer = setInterval(() => report(), config.timing.databaseLogSeconds * 1000)
		try {
			await generateOnDisk(db, wires, gates, catalog, {
				readRows: config.database.queryBatchSize, stageRows: config.database.generationBatchRows,
				parameterLimit: config.database.queryBatchSize, stateLimit: config.database.generationStates,
				keepState: config.database.keepGenerationState,
			}, entries => storeReplacers(db, entries, true), progress => {
				const newLayer = current?.depth !== progress.depth
				current = progress
				report(newLayer)
			})
			await runSQL(db, 'INSERT OR REPLACE INTO GenerationStatus VALUES(1,1)')
			logTimed(`Rainbow generation complete in ${generationDuration(performance.now() - started)}.`)
		} finally { clearInterval(timer) }
		return db
	} catch (error) { await new Promise<void>(resolve => db.close(() => resolve())); throw error }
}
