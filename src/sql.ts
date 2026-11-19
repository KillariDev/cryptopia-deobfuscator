import { observeSQL } from './sql-observer.js'
import sqlite3 from 'sqlite3'
export const runSQL = (db: sqlite3.Database, sql: string, params: unknown[] = []) => observeSQL(db, () => new Promise<number>((resolve, reject) => db.run(sql, params, function (error) { error ? reject(error) : resolve(this.changes) })))
export const allSQL = <T>(db: sqlite3.Database, sql: string, params: unknown[] = []) => observeSQL(db, () => new Promise<T[]>((resolve, reject) => db.all(sql, params, (error, rows) => error ? reject(error) : resolve(rows as T[]))))
/** SQLite releases the lock on exit. Keep the file so all runners lock the same inode. */
export async function withSQLiteLock<T>(filename: string, busyMessage: string, run: () => Promise<T>): Promise<T> {
	const db = await new Promise<sqlite3.Database>((resolve, reject) => {
		const handle = new sqlite3.Database(filename, error => error ? reject(error) : resolve(handle))
	})
	try {
		db.configure('busyTimeout', 0)
		try { await runSQL(db, 'BEGIN EXCLUSIVE') }
		catch (error) {
			if ((error as NodeJS.ErrnoException).code === 'SQLITE_BUSY') {
				throw new Error(busyMessage)
			}
			throw error
		}
		return await run()
	} finally {
		// Keep the lock file in place so all runners lock the same file.
		await new Promise<void>((resolve, reject) => db.close(error => error ? reject(error) : resolve()))
	}
}

/** Batch rows with a portable bind-variable budget. */
export async function insertRows(db: sqlite3.Database, prefix: string, rows: unknown[][], suffix: string, parameterLimit: number) {
	if (!rows.length) return
	const size = Math.max(1, Math.floor(parameterLimit / rows[0].length))
	for (let i = 0; i < rows.length; i += size) {
		const chunk = rows.slice(i, i + size)
		await runSQL(db, prefix + chunk.map(row => '(' + row.map(() => '?').join(',') + ')').join(',') + suffix, chunk.flat())
	}
}
