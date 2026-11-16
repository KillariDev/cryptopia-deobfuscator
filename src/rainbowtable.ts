import { semanticCircuits, decodeGates, encodeGates } from './semantic.js'
import { join } from 'path'
import { config } from './config.js'
import sqlite3 from 'sqlite3'
import { logVerbose } from './logging.js'
import { InputOutputReplacer, Gate } from './types.js'
import { evalCircuit, generateCombinations, getVars, ioHash, isReplacementSimpler, logTimed, toBatches } from './utils.js'
import { LimitedMap } from './limitedMap.js'

export const RAINBOW_TABLE_WIRES = config.database.wires
export const RAINBOW_TABLE_GATES = config.database.gates

const compact = config.database.format === 'compact'
const keyToSql = (key: string) => compact ? Buffer.from(key, 'hex') : key
const rowKey = (key: string | Buffer) => Buffer.isBuffer(key) ? key.toString('hex') : key
const gatesToBinary = (gates: Gate[]) => encodeGates(gates).toString('latin1')
const binaryToGates = decodeGates
export const databaseFilename = (wires: number, maxGates: number) => join(config.files.databaseDirectory, `canonHashrainbowtable_${wires}_${maxGates}${compact ? '.compact' : ''}.db`)
const readyDatabases = new WeakMap<sqlite3.Database, Promise<void>>()
export const databaseReady = (db: sqlite3.Database) => readyDatabases.get(db) ?? Promise.resolve()
const tuneDatabase = (db: sqlite3.Database) => {
	readyDatabases.set(db, new Promise<void>((resolve, reject) => {
		db.once('error', reject)
		db.run(`PRAGMA mmap_size=${config.database.memoryMapBytes}`, error => error ? reject(error) : resolve())
	}))
	return db
}

// Create table if not exists
const createTable = (db: sqlite3.Database) => {
	return new Promise<void>((resolve, reject) => {
		db.run(`
			CREATE TABLE IF NOT EXISTS InputOutputReplacers (
				ioIdentifier ${compact ? 'BLOB' : 'TEXT'} PRIMARY KEY,
				replacerGates ${compact ? 'BLOB' : 'TEXT'} NOT NULL
			) ${compact ? 'WITHOUT ROWID' : ''};
		`, (err: unknown) => {
			if (err) {
				reject(err)
			} else {
				resolve()
			}
		})
	})
}

export const storeReplacers = async (db: sqlite3.Database, replacers: Map<string, InputOutputReplacer>) => {
    // Fetch all existing entries in a single query
	logVerbose(`getting old entries`)

	const ios = Array.from(replacers.keys())

	const chunkSize = config.database.queryBatchSize

	const dbPromises: Promise<{ ioIdentifier: string, replacerGates: string }[]>[] = []
	for (let i = 0; i < ios.length; i += chunkSize) {
		const chunk = ios.slice(i, Math.min(i + chunkSize, ios.length))
		dbPromises.push(new Promise<{ ioIdentifier: string, replacerGates: string }[]>((resolve, reject) => {
			db.all('SELECT ioIdentifier, replacerGates FROM InputOutputReplacers WHERE ioIdentifier IN (' + chunk.map(() => '?').join(',') + ')', chunk.map(keyToSql), (err: unknown, rows: any[]) => {
				if (err) {
					reject(err)
				} else {
					rows.forEach(row => { row.ioIdentifier = rowKey(row.ioIdentifier) })
					const results = rows.map((row: any) => {
						if (row === undefined) return undefined
						return { ioIdentifier: row.ioIdentifier, replacerGates: row.replacerGates }
					}).filter((x): x is { ioIdentifier: string, replacerGates: string } => x !== undefined)
					resolve(results)
				}
			})
		}))
	}
	const existingEntries = (await Promise.all(dbPromises)).flat()
	const existingEntriesMap = new Map<string, { ioIdentifier: string, replacerGates: string }>()
	existingEntries.forEach((entry) => {
		existingEntriesMap.set(entry.ioIdentifier, entry)
	})

	logVerbose(`comparing...`)
	// Iterate over the replacers to decide which ones to insert or replace
	let insertAmount = 0
	let insertThese: [string,string][] = []
	for (const [ioIdentifier, replacer] of replacers) {
		const existingEntry = existingEntriesMap.get(ioIdentifier)
		if (!existingEntry || isReplacementSimpler(replacer.replacerGates, binaryToGates(existingEntry.replacerGates))) {
			// If the new entry is better, insert or replace it
			const replacerGatesJson = gatesToBinary(replacer.replacerGates)
			insertAmount++
			insertThese.push([ioIdentifier, replacerGatesJson])
		}
	}
	logVerbose(`inserting: ${ insertAmount }`)
	const insertChunkSize = config.database.insertBatchSize
	for (let i = 0; i < insertThese.length; i += insertChunkSize) {
		logVerbose('inserting...')
		const chunk = insertThese.slice(i, Math.min(i + insertChunkSize, insertThese.length))

		try {
			await new Promise<void>((resolve, reject) => {
				db.run('BEGIN TRANSACTION', (err) => {
					if (err) {
						reject(err)
					} else {
						resolve()
					}
				})
			})
			const stmt = db.prepare('INSERT OR REPLACE INTO InputOutputReplacers (ioIdentifier, replacerGates) VALUES (?, ?)')
			for (const insert of chunk) {
				await new Promise<void>((resolve, reject) => {
					stmt.run(keyToSql(insert[0]), compact ? Buffer.from(insert[1], 'latin1') : insert[1], (err: unknown) => {
						if (err) {
							reject(err)
						} else {
							resolve()
						}
					})
				})
			}
			// Finalize the statement and commit the transaction
			await new Promise<void>((resolve, reject) => {
				stmt.finalize((err) => {
					if (err) {
						reject(err)
					} else {
						db.run('COMMIT', (err) => {
							if (err) {
								reject(err)
							} else {
								logVerbose(`Replacers stored successfully.`)
								resolve()
							}
						})
					}
				})
			})
		} catch (err) {
			console.error(err)
			await new Promise<void>((_resolve, reject) => {
				db.run('ROLLBACK', (err) => {
					if (err) {
						reject(err)
					} else {
						reject(err)
					}
				})
			})
			throw err
		}
	}
	logVerbose(`finalized`)
}

export const getReplacerById = async (db: sqlite3.Database, ioIdentifierCache: LimitedMap<string, Gate[] | null>, ioIdentifier: string) => {
	const cacheHit = ioIdentifierCache.get(ioIdentifier)
	if (cacheHit !== undefined) {
		if (cacheHit === null) return null
		return cacheHit
	}
	return new Promise<Gate[] | null>((resolve, reject) => {
		db.get('SELECT * FROM InputOutputReplacers WHERE ioIdentifier = ?', [keyToSql(ioIdentifier)], (err: unknown, row: any) => {
			if (err) {
				reject(err)
			} else {
				if (row) {
					row.ioIdentifier = rowKey(row.ioIdentifier)
					const replacerGates = binaryToGates(row.replacerGates)
					ioIdentifierCache.set(row.ioIdentifier, replacerGates)
					resolve(replacerGates)
				} else {
					ioIdentifierCache.set(ioIdentifier, null)
					resolve(null)
				}
			}
		})
	})
}

export const getReplacersByIds = async (db: sqlite3.Database, ioIdentifierCache: LimitedMap<string, Gate[] | null>, ioIdentifiers: string[]) => {
    const cacheHits: { ioIdentifier: string, gates: Gate[] }[] = []
    const missingIdentifiers = new Set<string>()
    // Check cache first
    for (const ioIdentifier of ioIdentifiers) {
        const cacheHit = ioIdentifierCache.get(ioIdentifier)
        if (cacheHit !== undefined) {
            if (cacheHit !== null) {
                cacheHits.push({ ioIdentifier, gates: cacheHit })
            }
        } else {
            missingIdentifiers.add(ioIdentifier)
        }
    }
    // If there are no missing identifiers, return the cache hits
    if (missingIdentifiers.size === 0) return cacheHits

    const identifiers = [...missingIdentifiers]
    const chunkSize = config.database.queryBatchSize
    const dbPromises: Promise<{ ioIdentifier: string, gates: Gate[] }[]>[] = []

    // Query the database for the missing identifiers in chunks
    for (let i = 0; i < identifiers.length; i += chunkSize) {
        const chunk = identifiers.slice(i, i + chunkSize)
        dbPromises.push(new Promise<{ ioIdentifier: string, gates: Gate[] }[]>((resolve, reject) => {
            db.all('SELECT ioIdentifier, replacerGates FROM InputOutputReplacers WHERE ioIdentifier IN (' + chunk.map(() => '?').join(',') + ')', chunk.map(keyToSql), (err: unknown, rows: any[]) => {
                if (err) {
                    reject(err)
                } else {
                    rows.forEach(row => { row.ioIdentifier = rowKey(row.ioIdentifier) })
                    const found = new Set(rows.map((row: any) => row.ioIdentifier))
                    for (const id of chunk) {
                        if (!found.has(id)) ioIdentifierCache.set(id, null)
                    }
                    const results = rows.map((row: any) => {
                        const gates = binaryToGates(row.replacerGates)
                        ioIdentifierCache.set(row.ioIdentifier, gates)
                        return { ioIdentifier: row.ioIdentifier, gates }
                    }).filter((x): x is { ioIdentifier: string, gates: Gate[] } => x !== undefined)
                    resolve(results)
                }
            })
        }))
    }

    // Wait for all database queries to complete
    const dbResults = (await Promise.all(dbPromises)).flat()

    // Add cache hits to dbResults
    const allResults = [...cacheHits, ...dbResults]
    return allResults
}

export const isEmpty = async (db: sqlite3.Database) => {
	return new Promise<boolean>((resolve, reject) => {
		db.get('SELECT 1 FROM InputOutputReplacers LIMIT 1', (err: unknown, row: any) => {
			if (err) {
				reject(err)
				return
			}
			resolve(row === undefined)
		})
	})
}

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

const containsAllNumbersInOrder = (arr: number[]): boolean => {
	for (let i = 0; i < arr.length; i++) {
		if (arr[i] !== i) return false
	}
	return true
}

const FLUSH_SIZE = config.database.flushEntries

const flushIfNeeded = async (db: sqlite3.Database, rainbowMap: Map<string, InputOutputReplacer>) => {
	if (rainbowMap.size < FLUSH_SIZE) return
	logVerbose(`FLUSHING! entries:${ rainbowMap.size }`)
	await storeReplacers(db, rainbowMap)

	rainbowMap.clear()
	logVerbose('FLUSHING DONE')
}

export const getRainbowTable = (wires: number, maxGates: number) => {
	const filename = databaseFilename(wires, maxGates)
	const db = tuneDatabase(new sqlite3.Database(filename))
	return db
}

export function collectVariables(gates: Gate[]) {
	const variables: number[] = []
	const variableSet = new Set<number>()
	gates.forEach((gate) => {
		const gateVariables = getVars(gate)
		gateVariables.forEach((variable) => {
			if (!variableSet.has(variable)) {
				variableSet.add(variable)
				variables.push(variable)
			}
		})
	})
	return variables
}

export const createRainbowTable = async (wires: number, maxGates: number) => {
	const filename = databaseFilename(wires, maxGates)
	const db = tuneDatabase(new sqlite3.Database(filename))
	await databaseReady(db)
	await createTable(db)
	const get = (sql: string) => new Promise<any>((resolve, reject) => db.get(sql, (error, row) => error ? reject(error) : resolve(row)))
	const run = (sql: string) => new Promise<void>((resolve, reject) => db.run(sql, error => error ? reject(error) : resolve()))
	await run('CREATE TABLE IF NOT EXISTS GenerationStatus (id INTEGER PRIMARY KEY, complete INTEGER NOT NULL)')
	const status = await get('SELECT complete FROM GenerationStatus WHERE id=1')
	if (!await isEmpty(db) && status?.complete !== 0) {
		logTimed(`using rainbowtable ${ filename }`)
		return db
	}
	await run('INSERT OR REPLACE INTO GenerationStatus VALUES (1, 0)')
	logTimed(`creating rainbow table. Wires: ${ wires } Gates: ${ maxGates }`)
	let rainbowMap = new Map<string, InputOutputReplacer>()
	const combinations = generateCombinations(wires)
	const addgates = (gates: Gate[]) => {
		const uniqueVars = collectVariables(gates)
		if (!config.database.semanticGeneration && !containsAllNumbersInOrder(uniqueVars)) return
		const ioId = ioHash(combinations.flatMap((input) => evalCircuit(gates, input)))
		const old = rainbowMap.get(ioId)
		const newEntry = { ioIdentifier: ioId, replacerGates: gates }
		if (old === undefined || isReplacementSimpler(newEntry.replacerGates, old.replacerGates)) {
			rainbowMap.set(ioId, newEntry)
		}
	}
	const allGates = Array.from(generateAllGates(wires))
	logTimed(`different gates: ${ allGates.length }`)
	addgates([])
	if (config.database.semanticGeneration) {
		try {
			for (const gates of semanticCircuits(wires, maxGates, allGates, config.database.generationStates)) {
				addgates(gates)
				if (rainbowMap.size >= FLUSH_SIZE) await flushIfNeeded(db, rainbowMap)
			}
		} catch (error) { await new Promise<void>(resolve => db.close(() => resolve())); throw error }
	} else {
		// Iterative stack-based DFS to avoid nested loops
		type StackEntry = {
			sequence: Gate[],
			depth: number
		}
		const stack: StackEntry[] = [{ sequence: [], depth: 0 }]
		let lastSaved = performance.now()

		while (stack.length > 0) {
			const { sequence, depth } = stack.pop()!

			// Only add sequences that are complete (i.e., depth <= maxGates)
			if (depth <= maxGates) {
				addgates(sequence)
			}

			// Stop if we've reached maxGates
			if (depth >= maxGates) continue

			for (const gate of allGates) {
				const newSequence = [...sequence, gate]
				stack.push({ sequence: newSequence, depth: depth + 1 })
			}

			if (rainbowMap.size % config.database.flushCheckEntries === 0) {
				await flushIfNeeded(db, rainbowMap)
			}

			const now = performance.now()
			if (now - lastSaved >= config.timing.databaseLogSeconds * 1000) {
				logTimed(`rainbowsize: ${rainbowMap.size}`)
				lastSaved = now
			}
		}
	}

	await flushIfNeeded(db, rainbowMap)

	logTimed(`created rainbowtable of size: ${ rainbowMap.size }, inserting...`)
	await storeReplacers(db, rainbowMap)
	await run('INSERT OR REPLACE INTO GenerationStatus VALUES (1, 1)')
	logTimed(`Done`)
	return db
}
