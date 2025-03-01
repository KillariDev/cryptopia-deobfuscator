import sqlite3 from 'sqlite3'
import { InputOutputReplacer, Gate } from './types.js'
import { evalCircuit, generateCombinations, getUniqueVars, ioHash, logTimed, toBatches } from './utils.js'
import { LimitedMap } from './limitedMap.js'

const gatesToBinary = (gates: Gate[]): string => {
	let binary = ''
	for (const gate of gates) {
		// Pack a and b into 2 bytes
		binary += String.fromCharCode(gate.a)
		binary += String.fromCharCode(gate.b)
		// Pack target and gate_i into 1 byte, target into 4 least significant bits and gate_i into 4 most significant bits
		binary += String.fromCharCode((gate.gate_i << 4) | (gate.target & 0x0F))
	}
	return binary
}

const binaryToGates = (binary: string): Gate[] => {
	const gates: Gate[] = []
	for (let i = 0; i < binary.length; i += 3) {
		// Unpack a and b from 2 bytes
		const a = binary.charCodeAt(i)
		const b = binary.charCodeAt(i + 1)
		// Unpack target and gate_i from 1 byte, target from 4 least significant bits and gate_i from 4 most significant bits
		const target = binary.charCodeAt(i + 2) & 0x0F
		const gate_i = binary.charCodeAt(i + 2) >> 4
		gates.push({ a, b, target, gate_i })
	}
	return gates;
}

// Create table if not exists
const createTable = (db: sqlite3.Database) => {
	return new Promise<void>((resolve, reject) => {
		db.run(`
			CREATE TABLE IF NOT EXISTS InputOutputReplacers (
				ioIdentifier TEXT PRIMARY KEY,
				replacerGates TEXT NOT NULL,
				numberOfGates INTEGER NOT NULL,
				numberOfVariables INTEGER NOT NULL
			);
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
	logTimed(`getting old entries`)

	const ios = Array.from(replacers.keys())

	const chunkSize = 900
	
	const dbPromises: Promise<{ ioIdentifier: string, numberOfGates: number, numberOfVariables: number }[]>[] = []
	for (let i = 0; i < ios.length; i += chunkSize) {
		const chunk = ios.slice(i, Math.min(i + chunkSize, ios.length))
		dbPromises.push(new Promise<{ ioIdentifier: string, numberOfGates: number, numberOfVariables: number }[]>((resolve, reject) => {
			db.all('SELECT ioIdentifier, numberOfGates, numberOfVariables FROM InputOutputReplacers WHERE ioIdentifier IN (' + chunk.map(() => '?').join(',') + ')', chunk, (err: unknown, rows: any[]) => {
				if (err) {
					reject(err)
				} else {
					const results = rows.map((row: any) => {
						if (row === undefined) return undefined
						return { ioIdentifier: row.ioIdentifier, numberOfGates: row.numberOfGates, numberOfVariables: row.numberOfVariables }
					}).filter((x): x is { ioIdentifier: string, numberOfGates: number, numberOfVariables: number } => x !== undefined)
					resolve(results)
				}
			})
		}))
	}
	const existingEntries = (await Promise.all(dbPromises)).flat()
	const existingEntriesMap = new Map<string, { ioIdentifier: string, numberOfGates: number, numberOfVariables: number }>()
	existingEntries.forEach((entry) => {
		existingEntriesMap.set(entry.ioIdentifier, entry)
	})

	logTimed(`comparing...`)
	// Iterate over the replacers to decide which ones to insert or replace
	let insertAmount = 0
	let insertThese: any[] = []
	for (const [ioIdentifier, replacer] of replacers) {
		const existingEntry = existingEntriesMap.get(ioIdentifier)
		if (!existingEntry || 
			(replacer.numberOfGates < existingEntry.numberOfGates) || 
			(replacer.numberOfGates === existingEntry.numberOfGates && replacer.numberOfVariables < existingEntry.numberOfVariables)) {
			// If the new entry is better, insert or replace it
			const replacerGatesJson = gatesToBinary(replacer.replacerGates)
			insertAmount++
			insertThese.push([ioIdentifier, replacerGatesJson, replacer.numberOfGates, replacer.numberOfVariables])
		}
	}
	logTimed(`inserting: ${ insertAmount }`)
	const insertChunkSize = 1000000
	for (let i = 0; i < insertThese.length; i += insertChunkSize) {
		logTimed('inserting...')
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
			const stmt = db.prepare('INSERT OR REPLACE INTO InputOutputReplacers (ioIdentifier, replacerGates, numberOfGates, numberOfVariables) VALUES (?, ?, ?, ?)')
			for (const insert of chunk) {
				await new Promise<void>((resolve, reject) => {
					stmt.run(...insert, (err: unknown) => {
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
								logTimed(`Replacers stored successfully.`)
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
	logTimed(`finalized`)
}

export const getReplacerById = async (db: sqlite3.Database, ioIdentifierCache: LimitedMap<string, Gate[] | null>, ioIdentifier: string) => {
	const cacheHit = ioIdentifierCache.get(ioIdentifier)
	if (cacheHit !== undefined) {
		if (cacheHit === null) return null
		return cacheHit
	}
	return new Promise<Gate[] | null>((resolve, reject) => {
		db.get('SELECT * FROM InputOutputReplacers WHERE ioIdentifier = ?', [ioIdentifier], (err: unknown, row: any) => {
			if (err) {
				reject(err)
			} else {
				if (row) {
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
    const missingIdentifiers: string[] = []
    // Check cache first
    for (const ioIdentifier of ioIdentifiers) {
        const cacheHit = ioIdentifierCache.get(ioIdentifier)
        if (cacheHit !== undefined) {
            if (cacheHit !== null) {
                cacheHits.push({ ioIdentifier, gates: cacheHit })
            }
        } else {
            missingIdentifiers.push(ioIdentifier)
        }
    }
    // If there are no missing identifiers, return the cache hits
    if (missingIdentifiers.length === 0) return cacheHits

    const chunkSize = 900
    const dbPromises: Promise<{ ioIdentifier: string, gates: Gate[] }[]>[] = []

    // Query the database for the missing identifiers in chunks
    for (let i = 0; i < missingIdentifiers.length; i += chunkSize) {
        const chunk = missingIdentifiers.slice(i, Math.min(i + chunkSize, missingIdentifiers.length))
        dbPromises.push(new Promise<{ ioIdentifier: string, gates: Gate[] }[]>((resolve, reject) => {
            db.all('SELECT * FROM InputOutputReplacers WHERE ioIdentifier IN (' + chunk.map(() => '?').join(',') + ')', chunk, (err: unknown, rows: any[]) => {
                if (err) {
                    reject(err)
                } else {
                    const results = rows.map((row: any) => {
                        if (row === undefined) {
                            ioIdentifierCache.set(row.ioIdentifier, null)
                            return undefined
                        }
                        const gates = binaryToGates(row.replacerGates)
                        ioIdentifierCache.set(row.ioIdentifier, gates)
                        return { ioIdentifier: row.ioIdentifier as string, gates }
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

const isEmpty = async (db: sqlite3.Database) => {
	return new Promise<boolean>((resolve, reject) => {
		db.get('SELECT count(*) AS count FROM InputOutputReplacers', (err: unknown, row: any) => {
			if (err) {
				reject(err)
				return
			}
			resolve(row.count === 0)
		})
	})
}

function* generateAllGates(wires: number) {
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
							yield { a, b, target, gate_i }
						}
					}
					break
				}
				case 10: //return !b
				case 5: { //return b
					for (let b = 0; b < wires; b++) {
						yield { a: 0, b, target, gate_i }
					}
					break
				}
				case 12: //return !a
				case 3: { //return a
					for (let a = 0; a < wires; a++) {
						yield { a, b: 0, target, gate_i }
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

const containsAllNumbers = (arr: number[], N: number): boolean => {
	const set = new Set(arr)
	for (let i = 0; i < N; i++) {
		if (!set.has(i)) return false
	}
	return true
}

const FLUSH_SIZE = 15_000_000

const flushIfNeeded = async (db: sqlite3.Database, rainbowMap: Map<string, InputOutputReplacer>) => {
	if (rainbowMap.size < FLUSH_SIZE) {
		logTimed(`not flushing yet! entries:${ rainbowMap.size }`)
		return
	}
	logTimed(`FLUSHING! entries:${ rainbowMap.size }`)
	await storeReplacers(db, rainbowMap)

	rainbowMap.clear()
	logTimed('FLUSHING DONE')
}

export const getRainbowTable = (wires: number, maxGates: number) => {
	const filename = `bin2rainbowtable_${ wires }_${ maxGates }.db`
	const db = new sqlite3.Database(filename)
	return db
}

export const createRainbowTable = async (wires: number, maxGates: number) => {
	if (maxGates > 4) throw new Error('that many gates not supported')
	const filename = `bin2rainbowtable_${ wires }_${ maxGates }.db`
	const db = new sqlite3.Database(filename)
	await createTable(db)
	if (!await isEmpty(db)) {
		logTimed(`using rainbowtable ${ filename }`)
		return db
	}
	logTimed(`creating rainbow table. Wires: ${ wires } Gates: ${ maxGates }`)
	let rainbowMap = new Map<string, InputOutputReplacer>()
	const combinations = generateCombinations(wires)
	const addgates = (gates: Gate[]) => {
		const uniqueVars = getUniqueVars(gates)
		const newUniques = uniqueVars.length
		if (!containsAllNumbers(uniqueVars, newUniques)) return
		const ioId = ioHash(combinations.flatMap((input) => evalCircuit(gates, input)))
		const old = rainbowMap.get(ioId)
		const newEntry = { ioIdentifier: ioId, replacerGates: gates, numberOfVariables: newUniques, numberOfGates: gates.length }
		if (old === undefined) {
			rainbowMap.set(ioId, newEntry)
		} else {
			if (old.numberOfGates === newEntry.numberOfGates) {
				if (newUniques < old.numberOfVariables) rainbowMap.set(ioId, newEntry)
				return
			}
			if (old.numberOfGates > newEntry.numberOfGates) {
				rainbowMap.set(ioId, newEntry)
			}
		}
	}
	const allGates = Array.from(generateAllGates(wires))
	logTimed(`different gates: ${ allGates.length }`)
	const batches = toBatches(allGates, 10)
	if (maxGates >= 4) {
		logTimed('4 gates')
		for (const [i, gate0Batch] of batches.entries()) {
			logTimed(`iteration: ${i}/${batches.length}(${Math.floor(i/batches.length*100)}%)`)
			const start = performance.now()
			for (const gate0 of gate0Batch) {
				for (const gate1 of allGates) {
					for (const gate2 of allGates) {
						for (const gate3 of allGates) {
							addgates([gate0, gate1, gate2, gate3])
						}
					}
					await flushIfNeeded(db, rainbowMap)
				}
			}
			logTimed(`rainbowsize: ${rainbowMap.size}`)
			const end = performance.now()
			logTimed(`Execution time: ${end - start} ms`)
		}
		await flushIfNeeded(db, rainbowMap)
	}
	if (maxGates >= 3) {
		logTimed('3 gates')
		for (const [i, gate0Batch] of batches.entries()) {
			logTimed(`iteration: ${i}/${batches.length}(${Math.floor(i/batches.length*100)}%)`)
			const start = performance.now()
			for (const gate0 of gate0Batch) {
				for (const gate1 of allGates) {
					for (const gate2 of allGates) {
						addgates([gate0, gate1, gate2])
					}
				}
				await flushIfNeeded(db, rainbowMap)
			}
			logTimed(`rainbowsize: ${ rainbowMap.size }`)
			const end = performance.now()
			logTimed(`Execution time: ${end - start} ms`)
		}
		await flushIfNeeded(db, rainbowMap)
	}

	if (maxGates >= 2) {
		logTimed('2 gates')
		for (const gate0 of allGates) {
			for (const gate1 of allGates) {
				addgates([gate0, gate1])
			}
		}
		await flushIfNeeded(db, rainbowMap)
	}

	if (maxGates >= 1) {
		logTimed('1 gates')
		for (const gate0 of allGates) {
			addgates([gate0])
		}
		await flushIfNeeded(db, rainbowMap)
	}
	logTimed('0 gates')
	addgates([])
	logTimed(`created rainbowtable of size: ${ rainbowMap.size }, inserting...`)
	await storeReplacers(db, rainbowMap)
	logTimed(`Done`)
	return db
}
