import { observeSQL } from './sql-observer.js'
import sqlite3 from 'sqlite3'
import { allSQL, runSQL } from './sql.js'

export type StagingRow = [Buffer, number, number, Buffer, number]
export type StagingOptions = { parameterLimit: number, cacheEntries: number, prepared: boolean, sort: boolean, append?: boolean, appendGrouping?: boolean, compactBindings?: boolean }
const prefix = 'INSERT INTO BuildCandidates VALUES '
const appendPrefix = 'INSERT INTO BuildCandidateRows(state,mask,reads,gates,wires) VALUES '
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
		if (options.append) await runSQL(db, 'CREATE TEMP TABLE IF NOT EXISTS BuildCandidateRows(id INTEGER PRIMARY KEY,state BLOB NOT NULL,mask INTEGER NOT NULL,reads INTEGER NOT NULL,gates BLOB NOT NULL,wires INTEGER NOT NULL)')
		return new StagingWriter(db, await stagingParameterLimit(db, options.parameterLimit), options)
	}
	private finalize(statement: sqlite3.Statement) { return observeSQL(this.db, () => new Promise<void>((resolve, reject) => statement.finalize(error => error ? reject(error) : resolve()))) }
	write(rows: StagingRow[]): Promise<void> {
		if (this.closing) return Promise.reject(new Error('Staging writer is closed'))
		const task = this.tail.then(async () => {
			if (this.options.sort) rows.sort((a, b) => Buffer.compare(a[0], b[0]) || a[1] - b[1])
			const insertPrefix = this.options.append ? appendPrefix : prefix, insertSuffix = this.options.append ? '' : suffix
			const compact = this.options.compactBindings ?? false, columns = compact ? 3 : 5
			const size = Math.floor(this.parameterLimit / columns)
			for (let offset = 0; offset < rows.length; offset += size) {
				const count = Math.min(size, rows.length - offset)
				let statement = this.statements.get(count)
				const params: unknown[] = new Array(count * columns)
				for (let i = 0; i < count; i++) {
					const row = rows[offset + i], at = i * columns
					if (compact) {
						const [, mask, reads, , wires] = row
						if (!Number.isInteger(mask) || mask < 0 || mask > 255 || !Number.isInteger(reads) || reads < 0 || reads > 0xffffffff || !Number.isInteger(wires) || wires < 0 || wires > 8) throw new Error('Invalid compact staging cost')
						// 44 bits: exact in both a JS number and a SQLite int64.
						params[at] = row[0]; params[at + 1] = mask + reads * 256 + wires * 2 ** 40; params[at + 2] = row[3]
					} else for (let column = 0; column < columns; column++) params[at + column] = row[column]
				}
				const sql = () => compact
					? (this.options.append ? 'INSERT INTO BuildCandidateRows(state,mask,reads,gates,wires) ' : 'INSERT INTO BuildCandidates ') + 'SELECT column1,column2 & 255,(column2 >> 8) & 4294967295,column3,column2 >> 40 FROM (VALUES ' + Array(count).fill('(?,?,?)').join(',') + ') WHERE true' + insertSuffix
					: insertPrefix + Array(count).fill('(?,?,?,?,?)').join(',') + insertSuffix
				if (!this.options.prepared) {
					await runSQL(this.db, sql(), params)
				} else {
					if (statement) this.statements.delete(count)
					else {
						if (this.statements.size >= this.options.cacheEntries) {
							const [oldSize, oldest] = this.statements.entries().next().value!
							this.statements.delete(oldSize); await this.finalize(oldest)
						}
						statement = await observeSQL(this.db, () => new Promise<sqlite3.Statement>((resolve, reject) => {
							const prepared = this.db.prepare(sql(), error => error ? reject(error) : resolve(prepared))
						}))
						this.stats.statementsPrepared++
					}
					this.statements.set(count, statement)
					this.stats.peakCached = Math.max(this.stats.peakCached, this.statements.size)
					const current = statement
					try { await observeSQL(this.db, () => new Promise<void>((resolve, reject) => current.run(params, error => error ? reject(error) : resolve()))) }
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

	/** Called once after a complete read batch, inside the caller's transaction. */
	materialize(): Promise<void> {
		if (this.closing) return Promise.reject(new Error('Staging writer is closed'))
		if (!this.options.append) return this.tail.then(() => {})
		const task = this.tail.then(async () => {
			await runSQL(this.db, 'DELETE FROM BuildCandidates')
			const maxId = (await allSQL<{ maximum: number }>(this.db, 'SELECT COALESCE(MAX(id),0) AS maximum FROM BuildCandidateRows'))[0].maximum
			if ((this.options.appendGrouping ?? true) && maxId <= 0x7fffffff) {
				// uint32 reads * (maxId+1) + id fits signed int64 for this bound.
				// Unique ids make the minimum unique, preserving the first equal-cost row.
				await runSQL(this.db, `INSERT INTO BuildCandidates SELECT state,mask,reads,gates,wires FROM (
				 SELECT state,mask,reads,gates,wires,MIN(reads * CAST(? AS INTEGER) + id) AS quality FROM BuildCandidateRows GROUP BY state,mask
				) WHERE quality IS NOT NULL`, [maxId + 1])
			} else {
				// Keep exact ordering even for batches whose row ids exceed the safe score bound.
				await runSQL(this.db, `INSERT INTO BuildCandidates SELECT state,mask,reads,gates,wires FROM (
				 SELECT state,mask,reads,gates,wires,ROW_NUMBER() OVER (PARTITION BY state,mask ORDER BY reads,id) AS preference FROM BuildCandidateRows
				) WHERE preference=1`)
			}
			await runSQL(this.db, 'DELETE FROM BuildCandidateRows')
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
