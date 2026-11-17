import { observeSQL } from './sql-observer.js'
import sqlite3 from 'sqlite3'
export const runSQL = (db: sqlite3.Database, sql: string, params: unknown[] = []) => observeSQL(db, () => new Promise<number>((resolve, reject) => db.run(sql, params, function (error) { error ? reject(error) : resolve(this.changes) })))
export const allSQL = <T>(db: sqlite3.Database, sql: string, params: unknown[] = []) => observeSQL(db, () => new Promise<T[]>((resolve, reject) => db.all(sql, params, (error, rows) => error ? reject(error) : resolve(rows as T[]))))
/** Batch rows with a portable bind-variable budget. */
export async function insertRows(db: sqlite3.Database, prefix: string, rows: unknown[][], suffix: string, parameterLimit: number) {
	if (!rows.length) return
	const size = Math.max(1, Math.floor(parameterLimit / rows[0].length))
	for (let i = 0; i < rows.length; i += size) {
		const chunk = rows.slice(i, i + size)
		await runSQL(db, prefix + chunk.map(row => '(' + row.map(() => '?').join(',') + ')').join(',') + suffix, chunk.flat())
	}
}
