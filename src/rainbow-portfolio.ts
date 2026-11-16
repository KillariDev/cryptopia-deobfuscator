import sqlite3 from 'sqlite3'
import { LookupFunction } from './lookup-function.js'
import { config, RainbowTableSpec } from './config.js'
import { Gate } from './types.js'
import { LimitedMap } from './limitedMap.js'
import { getVars, isReplacementSimpler } from './utils.js'
import { createRainbowTable, databaseReady, getRainbowTable, getReplacersByIds } from './rainbowtable.js'

export type RainbowTableStats = RainbowTableSpec & { windows: number, matches: number, rewrites: number, gatesRemoved: number, lookupMs: number }
export type RainbowWindow = { mappedGates: Gate[], wires: number }
export type RainbowMatch = { gates: Gate[], table: string }
type OpenTable = RainbowTableSpec & { db: sqlite3.Database }
const tableId = (table: RainbowTableSpec) => `${table.wires}/${table.gates}`
const closeDatabase = (db: sqlite3.Database) => new Promise<void>((resolve, reject) => db.close(error => error ? reject(error) : resolve()))

/** Each table has its own truth-table width and cache namespace. */
export class RainbowPortfolio {
	private tables: (OpenTable & { id: string })[]
	private stats = new Map<string, RainbowTableStats>()
	readonly maximumWires: number
	constructor(tables: OpenTable[]) {
		if (!tables.length) throw new Error('Rainbow portfolio needs at least one table')
		this.tables = [...tables].sort((a, b) => a.wires - b.wires || a.gates - b.gates)
			.map(table => ({ ...table, id: tableId(table) }))
		this.maximumWires = Math.max(...tables.map(table => table.wires))
		this.resetStatistics()
	}
	resetStatistics() {
		this.stats = new Map(this.tables.map(({ id, wires, gates }) => [id, { wires, gates, windows: 0, matches: 0, rewrites: 0, gatesRemoved: 0, lookupMs: 0 }]))
	}
	statistics() { return [...this.stats.values()].map(stat => ({ ...stat })) }
	recordApplied(match: RainbowMatch, originalLength: number) {
		const stat = this.stats.get(match.table)!
		stat.rewrites++
		stat.gatesRemoved += originalLength - match.gates.length
	}
	async findReplacements(windows: RainbowWindow[], cache: LimitedMap<string, Gate[] | null>) {
		const found = new Map<number, RainbowMatch>()
		const functions = new Map<number, LookupFunction>()
		for (const table of this.tables) {
			const pending = windows.flatMap((window, index) => !found.has(index) && window.wires <= table.wires ? [{ window, index }] : [])
			if (!pending.length) continue
			const started = performance.now()
			const ids = pending.map(({ window, index }) => {
				let fn = functions.get(index)
				if (!fn) { fn = new LookupFunction(window.mappedGates, window.wires); functions.set(index, fn) }
				return fn.key(table.wires)
			})
			const rows = await getReplacersByIds(table.db, cache, ids, `rainbow:${table.id}:`)
			const matches = new Map(rows.map(row => [row.ioIdentifier, row.gates]))
			const stat = this.stats.get(table.id)!
			stat.windows += pending.length
			stat.lookupMs += performance.now() - started
			for (let i = 0; i < pending.length; i++) {
				const { window, index } = pending[i], gates = matches.get(ids[i])
				// A larger table must never borrow a wire missing from the window.
				if (gates && !gates.flatMap(getVars).some(wire => wire >= window.wires) && isReplacementSimpler(gates, window.mappedGates)) {
					found.set(index, { gates, table: table.id })
					stat.matches++
				}
			}
		}
		return found
	}
	async close() {
		const results = await Promise.allSettled(this.tables.map(table => closeDatabase(table.db)))
		for (const result of results) if (result.status === 'rejected') throw result.reason
	}
}

export async function initializeRainbowTables(tables = config.database.tables) {
	// Sequential generation bounds build memory and disk contention.
	for (const table of tables) await closeDatabase(await createRainbowTable(table.wires, table.gates))
}

export async function openRainbowPortfolio(tables = config.database.tables) {
	const opened = tables.map(table => ({ ...table, db: getRainbowTable(table.wires, table.gates) }))
	const results = await Promise.allSettled(opened.map(table => databaseReady(table.db)))
	const failed = results.find(result => result.status === 'rejected')
	if (failed?.status === 'rejected') {
		await Promise.allSettled(opened.map(table => closeDatabase(table.db)))
		throw failed.reason
	}
	return new RainbowPortfolio(opened)
}
