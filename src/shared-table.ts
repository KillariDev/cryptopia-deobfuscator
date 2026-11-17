import { existsSync } from 'fs'
import { config, RainbowTableSpec } from './config.js'
import { allSQL } from './sql.js'
import { databaseFilename, databaseReady, getRainbowTable, closeRainbowTable, hasCanonicalCoverage } from './rainbowtable.js'
import { decodeGates } from './semantic.js'

export type SharedTable = RainbowTableSpec & { keyBytes: number, slots: number, rows: number, keys: SharedArrayBuffer, offsets: SharedArrayBuffer, lengths: SharedArrayBuffer, payload: SharedArrayBuffer }
export type SharedRow = { ioIdentifier: Buffer, replacerGates: Buffer }
export const sharedTableBytes = (table: SharedTable) => table.keys.byteLength + table.offsets.byteLength + table.lengths.byteLength + table.payload.byteLength
const hash = (key: Uint8Array) => { let value = 2166136261; for (const byte of key) value = Math.imul(value ^ byte, 16777619); return value >>> 0 }

/** Construct once in the parent; workers receive the same backing buffers. */
export function createSharedTable(spec: RainbowTableSpec, rows: SharedRow[], budget: number): SharedTable | undefined {
	const keyBytes = Math.ceil(2 ** spec.wires * spec.wires / 8)
	let slots = 1
	while (slots < rows.length * 2) slots *= 2
	const payloadBytes = rows.reduce((sum, row) => sum + row.replacerGates.length, 0)
	if (slots * (keyBytes + 8) + payloadBytes > budget) return undefined
	const result: SharedTable = { ...spec, rows: rows.length, keyBytes, slots, keys: new SharedArrayBuffer(slots * keyBytes), offsets: new SharedArrayBuffer(slots * 4), lengths: new SharedArrayBuffer(slots * 4), payload: new SharedArrayBuffer(payloadBytes) }
	const keys = new Uint8Array(result.keys), offsets = new Int32Array(result.offsets), lengths = new Uint32Array(result.lengths), payload = new Uint8Array(result.payload)
	offsets.fill(-1)
	let position = 0
	for (const row of rows) {
		if (row.ioIdentifier.length !== keyBytes || row.replacerGates.length % 3) throw new Error('Invalid shared table row')
		let slot = hash(row.ioIdentifier) & (slots - 1)
		while (offsets[slot] !== -1) slot = (slot + 1) & (slots - 1)
		keys.set(row.ioIdentifier, slot * keyBytes); offsets[slot] = position; lengths[slot] = row.replacerGates.length
		payload.set(row.replacerGates, position); position += row.replacerGates.length
	}
	return result
}

/** Exposes reads only. No mutation or per-worker full-table copy is needed. */
export class SharedTableReader {
	private keys: Uint8Array
	private offsets: Int32Array
	private lengths: Uint32Array
	constructor(readonly table: SharedTable) {
		if (!Number.isSafeInteger(table.slots) || table.slots < 1 || (table.slots & (table.slots - 1)) || table.keyBytes !== Math.ceil(2 ** table.wires * table.wires / 8) || table.keys.byteLength !== table.slots * table.keyBytes || table.offsets.byteLength !== table.slots * 4 || table.lengths.byteLength !== table.slots * 4) throw new Error('Invalid shared table descriptor')
		this.keys = new Uint8Array(table.keys); this.offsets = new Int32Array(table.offsets); this.lengths = new Uint32Array(table.lengths)
	}
	get(id: string) {
		if (id.length !== this.table.keyBytes * 2 || !/^[0-9a-f]+$/i.test(id)) return null
		const key = Buffer.from(id, 'hex'), mask = this.table.slots - 1
		let slot = hash(key) & mask
		for (let probes = 0; probes < this.table.slots; probes++, slot = (slot + 1) & mask) {
			const offset = this.offsets[slot]
			if (offset === -1) return null
			if (!key.every((byte, i) => byte === this.keys[slot * key.length + i])) continue
			const length = this.lengths[slot]
			if (offset < 0 || offset + length > this.table.payload.byteLength || length % 3) throw new Error('Invalid shared table payload')
			return decodeGates(Buffer.from(this.table.payload, offset, length))
		}
		return null
	}
}

export async function loadSharedTables(): Promise<SharedTable[]> {
	if (!config.database.sharedTables) return []
	const results: SharedTable[] = []
	let remaining = config.database.sharedTableBytes
	for (const spec of config.database.tables) {
		if (!existsSync(databaseFilename(spec.wires, spec.gates))) continue
		const db = getRainbowTable(spec.wires, spec.gates)
		try {
			await databaseReady(db)
			if (!await hasCanonicalCoverage(db, spec.wires, spec.gates)) continue
			// Bound the admission scan, including for very large SQLite tables.
			const maximum = config.database.sharedTableMaximumRows
			const size = (await allSQL<{ rows: number, bytes: number }>(db, 'SELECT count(*) AS rows, coalesce(sum(bytes),0) AS bytes FROM (SELECT length(replacerGates) AS bytes FROM InputOutputReplacers LIMIT ?)', [maximum + 1]))[0]
			if (size.rows > maximum) continue
			let slots = 1; while (slots < size.rows * 2) slots *= 2
			if (slots * (Math.ceil(2 ** spec.wires * spec.wires / 8) + 8) + size.bytes > remaining) continue
			const rows = await allSQL<SharedRow>(db, 'SELECT ioIdentifier,replacerGates FROM InputOutputReplacers LIMIT ?', [maximum + 1])
			if (rows.length !== size.rows) throw new Error('Rainbow table changed during shared snapshot creation')
			const snapshot = createSharedTable(spec, rows, remaining)
			if (snapshot) { remaining -= sharedTableBytes(snapshot); results.push(snapshot) }
		} finally { await closeRainbowTable(db) }
	}
	return results
}
