import sqlite3 from 'sqlite3'
import { InputOutputReplacer, Gate } from './types.js'
import { evalCircuit, generateCombinations, getUniqueVars, getVars, ioHash, toBatches } from './utils.js'
import { LimitedMap } from './limitedMap.js'
import { BigMap } from './big.js'

// Create table if not exists
const createTable = (db: sqlite3.Database) => {
	return new Promise<void>((resolve, reject) => {
		db.run(`
			CREATE TABLE IF NOT EXISTS InputOutputReplacers (
				id INTEGER PRIMARY KEY AUTOINCREMENT,  -- Auto-incrementing id as the primary key
				ioIdentifier INTEGER NOT NULL UNIQUE,  -- Unique integer identifier
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

export const storeReplacers = async (db: sqlite3.Database, replacers: BigMap<string, InputOutputReplacer>) => {
	return new Promise<void>((resolve, reject) => {
		db.serialize(() => {
			db.run('BEGIN TRANSACTION')
			const stmt = db.prepare('INSERT OR REPLACE INTO InputOutputReplacers (ioIdentifier, replacerGates) VALUES (?, ?)')
			try {
				for (const [ioIdentifier, replacerGates] of replacers) {
					const replacerGatesJson = JSON.stringify(replacerGates.replacerGates)
					stmt.run(ioIdentifier, replacerGatesJson)
				}
				stmt.finalize((err: unknown) => {
					if (err) {
						reject(err)
					} else {
						db.run('COMMIT', (err: unknown) => {
							if (err) {
								reject(err)
							} else {
								console.log(`Replacers stored successfully.`)
								resolve()
							}
						})
					}
				})
			} catch (err) {
				db.run('ROLLBACK', () => {
					reject(err)
				})
			}
		})
	})
}

export const getReplacerById = async (db: sqlite3.Database, ioIdentifierCache: LimitedMap<string, Gate[] | null>, ioIdentifier: string) => {
	const cacheHit = ioIdentifierCache.get(ioIdentifier)
	if (cacheHit !== undefined) {
		if (cacheHit === null) return null
		return { ioIdentifier: ioIdentifier, replacerGates: cacheHit }
	}
	return new Promise<InputOutputReplacer | null>((resolve, reject) => {
		db.get('SELECT * FROM InputOutputReplacers WHERE ioIdentifier = ?', [ioIdentifier], (err: unknown, row: any) => {
			if (err) {
				reject(err)
			} else {
				if (row) {
					const replacerGates = JSON.parse(row.replacerGates) as Gate[]
					ioIdentifierCache.set(row.ioIdentifier, replacerGates)
					resolve({ ioIdentifier: row.ioIdentifier, replacerGates })
				} else {
					ioIdentifierCache.set(ioIdentifier, null)
					resolve(null)
				}
			}
		})
	})
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

export const createRainbowTable = async (wires: number, maxGates: number) => {
	const filename = `rainbowtable_${ wires }_${ maxGates }.db`
	if (maxGates > 4) throw new Error('that many gates not supported')
	const db = new sqlite3.Database(filename)
	await createTable(db)
	if (!await isEmpty(db)) {
		console.log(`using rainbowtable ${ filename }`)
		return db
	}
	console.log(`creating rainbow table. Wires: ${ wires } Gates: ${ maxGates }`)
	let rainbowMap = new BigMap<string, InputOutputReplacer>()
	const combinations = generateCombinations(wires)
	const addgates = (gates: Gate[]) => {
		const uniqueVars = getUniqueVars(gates)
		const newUniques = uniqueVars.length
		if (!containsAllNumbers(uniqueVars, newUniques)) return
		const mapping = combinations.flatMap((input) => (evalCircuit(gates, input) ))
		const replaced = { ioIdentifier: ioHash(mapping), replacerGates: gates }
		const old = rainbowMap.get(replaced.ioIdentifier)
		if (old === undefined) {
			rainbowMap.set(replaced.ioIdentifier, replaced)
		} else {
			if (old.replacerGates.length === gates.length) {
				const oldUniques = getUniqueVars(old.replacerGates).length
				if (newUniques < oldUniques) rainbowMap.set(replaced.ioIdentifier, replaced)
				return
			}
			if (old.replacerGates.length > gates.length) {
				rainbowMap.set(replaced.ioIdentifier, replaced)
			}
		}
	}
	const allGates = Array.from(generateAllGates(wires))
	console.log(`different gates: ${ allGates.length }`)
	const batches = toBatches(allGates, 10)
	if (maxGates >= 4) {
		console.log('4 gates')
		for (const [i, gate0Batch] of batches.entries()) {
			console.log(`iteration: ${i}/${batches.length}(${Math.floor(i/batches.length*100)}%)`)
			const start = performance.now()
			for (const gate0 of gate0Batch) {
				for (const gate1 of allGates) {
					for (const gate2 of allGates) {
						for (const gate3 of allGates) {
							addgates([gate0, gate1, gate2, gate3])
						}
					}
				}
			}
			console.log(`rainbowsize: ${rainbowMap.size}`)
			const end = performance.now()
			console.log(`Execution time: ${end - start} ms`)
		}
	}
	if (maxGates >= 3) {
		console.log('3 gates')
		for (const [i, gate0Batch] of batches.entries()) {
			console.log(`iteration: ${i}/${batches.length}(${Math.floor(i/batches.length*100)}%)`)
			const start = performance.now()
			for (const gate0 of gate0Batch) {
				for (const gate1 of allGates) {
					for (const gate2 of allGates) {
						addgates([gate0, gate1, gate2])
					}
				}
			}
			console.log(`rainbowsize: ${ rainbowMap.size }`)
			const end = performance.now()
			console.log(`Execution time: ${end - start} ms`)
		}
	}

	if (maxGates >= 2) {
		console.log('2 gates')
		for (const gate0 of allGates) {
			for (const gate1 of allGates) {
				addgates([gate0, gate1])
			}
		}
	}

	if (maxGates >= 1) {
		console.log('1 gates')
		for (const gate0 of allGates) {
			addgates([gate0])
		}
	}
	console.log('0 gates')
	addgates([])
	console.log(`created rainbowtable of size: ${ rainbowMap.size }, inserting...`)
	await storeReplacers(db, rainbowMap)
	console.log(`Done`)
	return db
}
