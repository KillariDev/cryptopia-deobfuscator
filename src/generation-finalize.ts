import sqlite3 from 'sqlite3'
import { allSQL, runSQL } from './sql.js'

/** Status 2 is durable: output is complete, cleanup/compaction must finish. */
export async function finalizeGeneration(db: sqlite3.Database, onPhase?: (phase: 'cleaning up' | 'compacting') => void) {
	const columns = await allSQL<{ name: string }>(db, 'PRAGMA table_info(InputOutputReplacers)')
	const costs = ['gateCount', 'wireCount', 'readCount'].filter(name => columns.some(column => column.name === name))
	if (costs.length && costs.length !== 3) throw new Error('Incomplete generation cost schema')
	onPhase?.('cleaning up')
	await runSQL(db, 'BEGIN IMMEDIATE')
	try {
		await runSQL(db, 'INSERT OR REPLACE INTO GenerationStatus VALUES(1,2)')
		await runSQL(db, 'DROP TABLE IF EXISTS temp.BuildCandidates')
		await runSQL(db, 'DROP TABLE IF EXISTS temp.BuildCandidateRows')
		for (const table of ['BuildSeen', 'BuildFrontier', 'BuildLayers']) await runSQL(db, `DROP TABLE IF EXISTS ${table}`)
		if (costs.length) {
			// One ordered rewrite removes all three costs, rather than three DROP COLUMN rewrites.
			await runSQL(db, 'CREATE TABLE FinishedOutput(ioIdentifier BLOB PRIMARY KEY,replacerGates BLOB NOT NULL) WITHOUT ROWID')
			await runSQL(db, 'INSERT INTO FinishedOutput SELECT ioIdentifier,replacerGates FROM InputOutputReplacers ORDER BY ioIdentifier')
			await runSQL(db, 'DROP TABLE InputOutputReplacers')
			await runSQL(db, 'ALTER TABLE FinishedOutput RENAME TO InputOutputReplacers')
		}
		const metadata = await allSQL<{ name: string }>(db, 'PRAGMA table_info(BuildMeta)')
		if (metadata.length > 3) {
			await runSQL(db, 'CREATE TABLE FinishedMeta(id INTEGER PRIMARY KEY,signature TEXT NOT NULL,depth INTEGER NOT NULL)')
			await runSQL(db, 'INSERT INTO FinishedMeta SELECT id,signature,depth FROM BuildMeta')
			await runSQL(db, 'DROP TABLE BuildMeta')
			await runSQL(db, 'ALTER TABLE FinishedMeta RENAME TO BuildMeta')
		}
		await runSQL(db, 'COMMIT')
	} catch (error) { await runSQL(db, 'ROLLBACK'); throw error }
	const checkpoint = async () => {
		const rows = await allSQL<{ busy: number }>(db, 'PRAGMA wal_checkpoint(TRUNCATE)')
		if (rows.some(row => row.busy > 0)) throw new Error('Compaction checkpoint is busy; restart to finish compaction')
	}
	await checkpoint()
	// VACUUM is atomic and runs outside a transaction. Failure leaves status 2 for retry.
	onPhase?.('compacting')
	await runSQL(db, 'VACUUM')
	await checkpoint()
	await runSQL(db, 'INSERT OR REPLACE INTO GenerationStatus VALUES(1,1)')
	await checkpoint()
}
