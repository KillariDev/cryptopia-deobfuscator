import sqlite3 from 'sqlite3'
import { InputOutputReplacer, Gate } from './types.js'
import { evalCircuit, generateCombinations, getVars, ioHash, isReplacementSimpler, logTimed, toBatches } from './utils.js'
import { LimitedMap } from './limitedMap.js'

export const RAINBOW_TABLE_WIRES = 4
export const RAINBOW_TABLE_GATES = 4

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
				replacerGates TEXT NOT NULL
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
	
	const dbPromises: Promise<{ ioIdentifier: string, replacerGates: string }[]>[] = []
	for (let i = 0; i < ios.length; i += chunkSize) {
		const chunk = ios.slice(i, Math.min(i + chunkSize, ios.length))
		dbPromises.push(new Promise<{ ioIdentifier: string, replacerGates: string }[]>((resolve, reject) => {
			db.all('SELECT ioIdentifier, replacerGates FROM InputOutputReplacers WHERE ioIdentifier IN (' + chunk.map(() => '?').join(',') + ')', chunk, (err: unknown, rows: any[]) => {
				if (err) {
					reject(err)
				} else {
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

	logTimed(`comparing...`)
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
			const stmt = db.prepare('INSERT OR REPLACE INTO InputOutputReplacers (ioIdentifier, replacerGates) VALUES (?, ?)')
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
            db.all('SELECT ioIdentifier, replacerGates FROM InputOutputReplacers WHERE ioIdentifier IN (' + chunk.map(() => '?').join(',') + ')', chunk, (err: unknown, rows: any[]) => {
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

const isEmpty = async (db: sqlite3.Database) => {
	return new Promise<boolean>((resolve, reject) => {
		db.get('SELECT count(*) AS count FROM InputOutputReplacers', (err: unknown, row: any) => {
			if (err) {
				reject(err)
				return
			}
			console.log(`db contains ${ row.count } rows`)
			resolve(row.count === 0)
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

const FLUSH_SIZE = 15_000_000

const flushIfNeeded = async (db: sqlite3.Database, rainbowMap: Map<string, InputOutputReplacer>) => {
	if (rainbowMap.size < FLUSH_SIZE) return
	logTimed(`FLUSHING! entries:${ rainbowMap.size }`)
	await storeReplacers(db, rainbowMap)

	rainbowMap.clear()
	logTimed('FLUSHING DONE')
}

export const getRainbowTable = (wires: number, maxGates: number) => {
	const filename = `canonHashrainbowtable_${ wires }_${ maxGates }.db`
	const db = new sqlite3.Database(filename)
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
	if (maxGates !== 4) throw new Error('only four gates supported')
	const filename = `canonHashrainbowtable_${ wires }_${ maxGates }.db`
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
		const uniqueVars = collectVariables(gates)
		if (!containsAllNumbersInOrder(uniqueVars)) return
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
	let lastSaved = performance.now()
	const batches = toBatches(allGates, 10)
	for (const [i, gate0Batch] of batches.entries()) {
		for (const gate0 of gate0Batch) {
			const newGates = [gate0]
			const uniqueVars = collectVariables(newGates)
			if (!containsAllNumbersInOrder(uniqueVars)) continue
			addgates(newGates)
			for (const gate1 of allGates) {
				const newGates = [gate0, gate1]
				const uniqueVars = collectVariables(newGates)
				if (!containsAllNumbersInOrder(uniqueVars)) continue
				addgates(newGates)
				for (const gate2 of allGates) {
					const newGates = [gate0, gate1, gate2]
					const uniqueVars = collectVariables(newGates)
					if (!containsAllNumbersInOrder(uniqueVars)) continue
					addgates(newGates)
					for (const gate3 of allGates) {
						addgates([gate0, gate1, gate2, gate3])
					}
				}
				await flushIfNeeded(db, rainbowMap)
				const endTime = performance.now()
				const timeDiffMins = (endTime - lastSaved) / 60000
				if (timeDiffMins >= 1) {
					logTimed(`rainbowsize: ${rainbowMap.size}`)
					lastSaved = performance.now()
					logTimed(`iteration: ${i}/${batches.length}(${Math.floor(i/batches.length*100)}%)`)
				}
			}
		}
	}
	await flushIfNeeded(db, rainbowMap)

	logTimed(`created rainbowtable of size: ${ rainbowMap.size }, inserting...`)
	await storeReplacers(db, rainbowMap)
	logTimed(`Done`)
	return db
}
