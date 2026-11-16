import sqlite3 from 'sqlite3'
import { existsSync, openSync, closeSync, renameSync, unlinkSync } from 'fs'
import { resolve } from 'path'
import { decodeGates, encodeGates, truthKey } from './semantic.js'
import { calculateAllOutputsArray, generateCombinations, hashBooleanArrays } from './utils.js'

export async function migrateDatabase(source: string, destination: string, wires: number, batchSize: number, onProgress?: (rows: number) => void) {
	if (resolve(source) === resolve(destination) || existsSync(destination)) throw new Error('Migration requires a new destination; source is never modified')
	const temporary = destination + '.building'
	closeSync(openSync(temporary, 'wx'))
	let input!: sqlite3.Database, output!: sqlite3.Database
	const inputReady = new Promise<void>((resolve, reject) => { input = new sqlite3.Database(source, sqlite3.OPEN_READONLY, error => error ? reject(error) : resolve()) })
	const outputReady = new Promise<void>((resolve, reject) => { output = new sqlite3.Database(temporary, error => error ? reject(error) : resolve()) })
	const run = (sql: string, params: unknown[] = []) => new Promise<void>((resolve, reject) => output.run(sql, params, error => error ? reject(error) : resolve()))
	const rows = (after: number) => new Promise<any[]>((resolve, reject) => input.all('SELECT rowid, ioIdentifier, replacerGates FROM InputOutputReplacers WHERE rowid > ? ORDER BY rowid LIMIT ?', [after, batchSize], (error, rows) => error ? reject(error) : resolve(rows)))
	const close = (db: sqlite3.Database) => new Promise<void>(resolve => db.close(() => resolve()))
	let finished = false, count = 0
	try {
		await Promise.all([inputReady, outputReady])
		const query = (sql: string) => new Promise<any>((resolve, reject) => input.get(sql, (error, row) => error ? reject(error) : resolve(row)))
		if (await query("SELECT name FROM sqlite_master WHERE type='table' AND name='GenerationStatus'")) {
			if ((await query('SELECT complete FROM GenerationStatus WHERE id=1'))?.complete === 0) throw new Error('Cannot migrate an incomplete generation')
		}
		await run('CREATE TABLE InputOutputReplacers (ioIdentifier BLOB PRIMARY KEY, replacerGates BLOB NOT NULL) WITHOUT ROWID')
		await run('CREATE TABLE GenerationStatus (id INTEGER PRIMARY KEY, complete INTEGER NOT NULL)')
		const inputs = generateCombinations(wires)
		let last = -1
		while (true) {
			const batch = await rows(last)
			if (!batch.length) break
			await run('BEGIN')
			for (const row of batch) {
				const gates = decodeGates(row.replacerGates)
				const outputs = calculateAllOutputsArray(gates, inputs)
				if (hashBooleanArrays(outputs) !== row.ioIdentifier) throw new Error(`Invalid legacy entry at row ${row.rowid}; migration stopped`)
				await run('INSERT INTO InputOutputReplacers VALUES (?, ?)', [truthKey(outputs), encodeGates(gates)])
				last = row.rowid
				count++
			}
			await run('COMMIT')
			onProgress?.(count)
		}
		await run('INSERT INTO GenerationStatus VALUES (1, 1)')
		finished = true
	} finally {
		await close(input)
		await close(output)
		if (!finished) unlinkSync(temporary)
	}
	renameSync(temporary, destination)
	return count
}
