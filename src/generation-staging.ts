import sqlite3 from 'sqlite3'
import { allSQL, runSQL } from './sql.js'

export type StagingRow = [Buffer, number, number, Buffer, number]
export type StagingOptions = { parameterLimit: number, cacheEntries: number, prepared: boolean, sort: boolean }
const prefix = 'INSERT INTO BuildCandidates VALUES '
const suffix = ' ON CONFLICT(state,mask) DO UPDATE SET reads=excluded.reads,gates=excluded.gates WHERE excluded.reads<BuildCandidates.reads'

/** This connection does not lower SQLite's runtime limit; honor its compiled ceiling. */
export async function stagingParameterLimit(db: sqlite3.Database, requested: number) {
	if (!Number.isSafeInteger(requested) || requested < 5) throw new Error('Staging requires a parameter budget of at least five')
	const options = await allSQL<{ compile_options: string }>(db, 'PRAGMA compile_options')
	const value = options.map(row => /^MAX_VARIABLE_NUMBER=(\d+)$/.exec(row.compile_options)).find(Boolean)
	const supported = value ? Number(value[1]) : 999
	if (!Number.isSafeInteger(supported) || supported < 5) throw new Error('SQLite parameter limit cannot stage one candidate')
	return Math.min(requested, supported)
}

/** One bounded, serialized statement cache per generation connection. */
export class StagingWriter {
	private statements = new Map<number, sqlite3.Statement>()
	private tail: Promise<unknown> = Promise.resolve()
	private closing?: Promise<void>
	readonly stats = { statementsPrepared: 0, executions: 0, peakCached: 0 }
	private constructor(private db: sqlite3.Database, readonly parameterLimit: number, private options: StagingOptions) {}
	static async create(db: sqlite3.Database, options: StagingOptions) {
		if (!Number.isSafeInteger(options.cacheEntries) || options.cacheEntries < 1) throw new Error('Invalid staging statement cache size')
		return new StagingWriter(db, await stagingParameterLimit(db, options.parameterLimit), options)
	}
	private finalize(statement: sqlite3.Statement) { return new Promise<void>((resolve, reject) => statement.finalize(error => error ? reject(error) : resolve())) }
	write(rows: StagingRow[]): Promise<void> {
		if (this.closing) return Promise.reject(new Error('Staging writer is closed'))
		const task = this.tail.then(async () => {
			if (this.options.sort) rows.sort((a, b) => Buffer.compare(a[0], b[0]) || a[1] - b[1])
			const size = Math.floor(this.parameterLimit / 5)
			for (let offset = 0; offset < rows.length; offset += size) {
				const count = Math.min(size, rows.length - offset)
				let statement = this.statements.get(count)
				const params = rows.slice(offset, offset + count).flat()
				if (!this.options.prepared) {
					await runSQL(this.db, prefix + Array(count).fill('(?,?,?,?,?)').join(',') + suffix, params)
				} else {
					if (statement) this.statements.delete(count)
					else {
						if (this.statements.size >= this.options.cacheEntries) {
							const [oldSize, oldest] = this.statements.entries().next().value!
							this.statements.delete(oldSize); await this.finalize(oldest)
						}
						statement = await new Promise<sqlite3.Statement>((resolve, reject) => {
							const prepared = this.db.prepare(prefix + Array(count).fill('(?,?,?,?,?)').join(',') + suffix, error => error ? reject(error) : resolve(prepared))
						})
						this.stats.statementsPrepared++
					}
					this.statements.set(count, statement)
					this.stats.peakCached = Math.max(this.stats.peakCached, this.statements.size)
					const current = statement
					try { await new Promise<void>((resolve, reject) => current.run(params, error => error ? reject(error) : resolve())) }
					catch (error) {
						this.statements.delete(count)
						await this.finalize(current).catch(() => {})
						throw error
					}
				}
				this.stats.executions++
			}
		})
		this.tail = task.catch(() => {})
		return task
	}
	close() {
		return this.closing ??= this.tail.then(async () => {
			const results = await Promise.allSettled([...this.statements.values()].map(statement => this.finalize(statement)))
			this.statements.clear()
			for (const result of results) if (result.status === 'rejected') throw result.reason
		})
	}
}
