import sqlite3 from 'sqlite3'
import { Gate, InputOutputReplacer } from './types.js'
import { applyState, circuitState, decodeGates, encodeGates } from './semantic.js'
import { getVars, hashGates, ioHash } from './utils.js'
import { runSQL, allSQL, insertRows } from './sql.js'
import { SemanticProgress } from './generation-progress.js'

type Meta = { signature: string, depth: number, processed: number, total: number, functions: number }
type Entry = { id: number, state: Buffer, mask: number, reads: number, gates: Buffer }
export type DiskGenerationOptions = { readRows: number, stageRows: number, parameterLimit: number, stateLimit: number, keepState: boolean }

/** One committed batch owns both its results and its frontier advance. */
export async function generateOnDisk(db: sqlite3.Database, wires: number, maximumDepth: number, catalog: Gate[], options: DiskGenerationOptions,
	store: (entries: Map<string, InputOutputReplacer>) => Promise<void>, onProgress?: (progress: SemanticProgress) => void, shouldPause?: () => boolean) {
	const run = (sql: string, params: unknown[] = []) => runSQL(db, sql, params)
	await run('CREATE TABLE IF NOT EXISTS BuildMeta (id INTEGER PRIMARY KEY, signature TEXT NOT NULL, depth INTEGER NOT NULL, processed INTEGER NOT NULL, total INTEGER NOT NULL, functions INTEGER NOT NULL)')
	await run('CREATE TABLE IF NOT EXISTS BuildSeen (state BLOB PRIMARY KEY, depth INTEGER NOT NULL) WITHOUT ROWID')
	await run('CREATE TABLE IF NOT EXISTS BuildFrontier (id INTEGER PRIMARY KEY, state BLOB NOT NULL, mask INTEGER NOT NULL, reads INTEGER NOT NULL, gates BLOB NOT NULL, depth INTEGER NOT NULL, UNIQUE(state,mask))')
	await run('CREATE INDEX IF NOT EXISTS BuildFrontierDepth ON BuildFrontier(depth,id)')
	await run('CREATE TEMP TABLE IF NOT EXISTS BuildCandidates (state BLOB NOT NULL, mask INTEGER NOT NULL, reads INTEGER NOT NULL, gates BLOB NOT NULL, PRIMARY KEY(state,mask)) WITHOUT ROWID')
	const signature = `labeled-sorted-v1:${wires}:${maximumDepth}:${hashGates(catalog)}`
	let meta = (await allSQL<Meta>(db, 'SELECT * FROM BuildMeta WHERE id=1'))[0]
	if (meta && meta.signature !== signature) throw new Error('Cannot resume generation with a different catalog or wire/gate limits')
	if (!meta) {
		const identity = Buffer.from(circuitState([], wires))
		await run('BEGIN IMMEDIATE')
		try {
			await run('INSERT INTO BuildSeen VALUES (?,0)', [identity])
			await run('INSERT INTO BuildFrontier(state,mask,reads,gates,depth) VALUES (?,0,0,?,0)', [identity, Buffer.alloc(0)])
			await run('INSERT INTO BuildMeta VALUES (1,?,0,0,1,1)', [signature])
			await run('COMMIT')
		} catch (error) { await run('ROLLBACK'); throw error }
		meta = { signature, depth: 0, processed: 0, total: 1, functions: 1 }
	}
	const gates = catalog.map(gate => ({ gate, encoded: encodeGates([gate]), mask: getVars(gate).reduce((mask, wire) => mask | 1 << wire, 0), reads: getVars(gate).length }))
	let startDepth = meta.depth, startProcessed = meta.processed
	const report = () => onProgress?.({ depth: meta.depth, processed: meta.processed, total: meta.total, states: meta.functions, processedThisRun: meta.processed - startProcessed, disk: true })
	while (meta.depth <= maximumDepth) {
		if (meta.depth !== startDepth) { startDepth = meta.depth; startProcessed = 0 }
		report()
		if (shouldPause?.()) return false
		const batch = await allSQL<Entry>(db, 'SELECT id,state,mask,reads,gates FROM BuildFrontier WHERE depth=? ORDER BY id LIMIT ?', [meta.depth, options.readRows])
		if (!batch.length) {
			const next = meta.depth + 1
			const total = (await allSQL<{ count: number }>(db, 'SELECT count(*) AS count FROM BuildFrontier WHERE depth=?', [next]))[0].count
			await run('UPDATE BuildMeta SET depth=?,processed=0,total=? WHERE id=1', [total ? next : maximumDepth + 1, total])
			meta.depth = total ? next : maximumDepth + 1
			meta.processed = 0; meta.total = total
			continue
		}
		const priorFunctions = meta.functions
		await run('BEGIN IMMEDIATE')
		try {
			const results = new Map<string, InputOutputReplacer>()
			let candidates: unknown[][] = []
			const flush = async () => {
				if (!candidates.length) return
				await insertRows(db, 'INSERT INTO BuildCandidates VALUES ', candidates, ' ON CONFLICT(state,mask) DO UPDATE SET reads=excluded.reads,gates=excluded.gates WHERE excluded.reads<BuildCandidates.reads', options.parameterLimit)
				candidates = []
				meta.functions += await run('INSERT INTO BuildSeen SELECT state,? FROM BuildCandidates GROUP BY state ON CONFLICT(state) DO NOTHING', [meta.depth + 1])
				if (options.stateLimit && meta.functions > options.stateLimit) throw new Error('Disk generation state limit reached; increase database.generationStates or set it to 0')
				await run('INSERT INTO BuildFrontier(state,mask,reads,gates,depth) SELECT c.state,c.mask,c.reads,c.gates,? FROM BuildCandidates c JOIN BuildSeen s ON c.state=s.state WHERE s.depth=? ON CONFLICT(state,mask) DO UPDATE SET reads=excluded.reads,gates=excluded.gates WHERE excluded.reads<BuildFrontier.reads', [meta.depth + 1, meta.depth + 1])
				await run('DELETE FROM BuildCandidates')
			}
			for (const entry of batch) {
				const outputs = [...entry.state].flatMap(word => Array.from({ length: wires }, (_, wire) => !!(word & (1 << wire))))
				const ioIdentifier = ioHash(outputs)
				results.set(`${ioIdentifier}:${entry.mask}`, { ioIdentifier, replacerGates: decodeGates(entry.gates) })
				if (meta.depth < maximumDepth) for (const gate of gates) {
					candidates.push([Buffer.from(applyState(entry.state, gate.gate)), entry.mask | gate.mask, entry.reads + gate.reads, Buffer.concat([entry.gates, gate.encoded])])
					if (candidates.length >= options.stageRows) await flush()
				}
			}
			await flush()
			await store(results)
			await run('DELETE FROM BuildFrontier WHERE depth=? AND id<=?', [meta.depth, batch[batch.length - 1].id])
			await run('UPDATE BuildMeta SET processed=processed+?,functions=? WHERE id=1', [batch.length, meta.functions])
			await run('COMMIT')
			meta.processed += batch.length
		} catch (error) { meta.functions = priorFunctions; await run('ROLLBACK'); throw error }
	}
	if (!options.keepState) {
		await run('DROP TABLE BuildFrontier')
		await run('DROP TABLE BuildSeen')
	}
	return true
}
