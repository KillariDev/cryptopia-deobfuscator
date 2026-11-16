import sqlite3 from 'sqlite3'

/** A bounded LRU, serialized per connection so bindings are never shared concurrently. */
export class LookupStatements {
	private statements = new Map<number, sqlite3.Statement>()
	private tail: Promise<unknown> = Promise.resolve()
	private closing?: Promise<void>
	constructor(private db: sqlite3.Database, private maximum: number) {
		if (!Number.isSafeInteger(maximum) || maximum < 1) throw new Error('Invalid statement cache limit')
	}
	private finalize(statement: sqlite3.Statement) { return new Promise<void>((resolve, reject) => statement.finalize(error => error ? reject(error) : resolve())) }
	query<T>(ids: Buffer[]): Promise<T[]> {
		if (this.closing) return Promise.reject(new Error('Lookup statements are closed'))
		if (!ids.length) return Promise.resolve([])
		const task = this.tail.then(async () => {
			let statement = this.statements.get(ids.length)
			if (!statement) {
				if (this.statements.size >= this.maximum) {
					const [size, oldest] = this.statements.entries().next().value!
					this.statements.delete(size); await this.finalize(oldest)
				}
				statement = await new Promise<sqlite3.Statement>((resolve, reject) => {
					const value = this.db.prepare('SELECT ioIdentifier,replacerGates FROM InputOutputReplacers WHERE ioIdentifier IN (' + ids.map(() => '?').join(',') + ')', error => error ? reject(error) : resolve(value))
				})
			} else this.statements.delete(ids.length)
			this.statements.set(ids.length, statement)
			try {
				const current = statement
				const rows = await new Promise<T[]>((resolve, reject) => current.all(ids, (error: Error | null, rows: T[]) => error ? reject(error) : resolve(rows)))
				await new Promise<void>((resolve, reject) => current.reset(error => error ? reject(error) : resolve()))
				return rows
			} catch (error) {
				this.statements.delete(ids.length)
				await this.finalize(statement).catch(() => {})
				throw error
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
