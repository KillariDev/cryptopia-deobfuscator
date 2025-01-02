import sqlite3 from 'sqlite3'
import { InputOutputReplacer, Gate } from './types.js'
import { evalCircuit, generateCombinations, getUniqueVars, ioHash, toBatches } from './utils.js'

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

export const storeReplacers = async (db: sqlite3.Database, replacers: InputOutputReplacer[]) => {
	return new Promise<void>((resolve, reject) => {
		db.serialize(() => {
			db.run('BEGIN TRANSACTION')
			const stmt = db.prepare('INSERT OR REPLACE INTO InputOutputReplacers (ioIdentifier, replacerGates) VALUES (?, ?)')
			try {
				for (const replacer of replacers) {
					const replacerGatesJson = JSON.stringify(replacer.replacerGates)
					stmt.run(replacer.ioIdentifier, replacerGatesJson)
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

export const getReplacerById = async (db: sqlite3.Database, ioIdentifier: string) => {
	return new Promise<InputOutputReplacer | null>((resolve, reject) => {
		db.get('SELECT * FROM InputOutputReplacers WHERE ioIdentifier = ?', [ioIdentifier], (err: unknown, row: any) => {
			if (err) {
				reject(err)
			} else {
				if (row) {
					const replacerGates = JSON.parse(row.replacerGates) as Gate[]
					resolve({ ioIdentifier: row.ioIdentifier, replacerGates })
				} else {
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
	for (let a = 0; a < wires; a++) {
		for (let b = a + 1; b < wires; b++) {
			for (let target = 0; target < wires; target++) {
				for (let gate_i = 0; gate_i < 16; gate_i++) {
					yield { a, b, target, gate_i }
				}
			}
		}
	}
}

export const createRainbowTable = async (wires: number) => {
	const filename = 'rainbowtable.db'
	const db = new sqlite3.Database(filename)
	await createTable(db)
	if (!await isEmpty(db)) {
		console.log(`using rainbowtable ${ filename }`)
		return db
	}
	console.log(`creating rainbow table. Wires:${ wires }`)
	let rainbowMap = new Map<string, InputOutputReplacer>()
	const combinations = generateCombinations(wires)
	const addgates = (gates: Gate[]) => {
		const mapping = combinations.flatMap((input) => (evalCircuit(gates, input) ))
		const replaced = { ioIdentifier: ioHash(mapping), replacerGates: gates }
		const old = rainbowMap.get(replaced.ioIdentifier)
		if (old === undefined) {
			rainbowMap.set(replaced.ioIdentifier, replaced)
		} else {
			const oldUniques = getUniqueVars(old.replacerGates).length
			const newUniques = getUniqueVars(gates).length
			if (old.replacerGates.length >= gates.length && newUniques <= oldUniques) rainbowMap.set(replaced.ioIdentifier, replaced)
		}
	}
	const allGates = Array.from(generateAllGates(wires))
	console.log('3 gates')
	const batches = toBatches(allGates, 10)
	for (const [i, gate0Batch] of batches.entries()) {
		console.log(`iteration: ${i}/${batches.length}(${Math.floor(i/batches.length*100)}%)`)
		const start = performance.now()
		for (const gate0 of gate0Batch) {
			for (const gate1 of allGates) {
				for (const gate3 of allGates) {
					addgates([gate0, gate1, gate3])
				}
			}
		}
		console.log(`rainbowsize: ${rainbowMap.size}`)
		const end = performance.now()
		console.log(`Execution time: ${end - start} ms`)
	}

	console.log('2 gates')
	for (const gate0 of allGates) {
		for (const gate1 of allGates) {
			addgates([gate0, gate1])
		}
	}

	console.log('1 gates')
	for (const gate0 of allGates) {
		addgates([gate0])
	}
	addgates([])
	console.log(`created rainbowtable of size: ${rainbowMap.size}`)
	await storeReplacers(db, Array.from(rainbowMap.entries()).map(([_,x]) => x))
	return db
}
