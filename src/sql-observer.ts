import sqlite3 from 'sqlite3'
import { EventEmitter } from 'events'
export type SQLSnapshot = { calls: number, awaitMs: number, nativeCalls: number, nativeMs: number, active: number, oldestMs: number, maxMs: number }
const observers = new WeakMap<sqlite3.Database, SQLObserver>()
export function observeSQL<T>(db: sqlite3.Database, operation: () => Promise<T>): Promise<T> {
	return observers.get(db)?.measure(operation) ?? operation()
}
/** Native profile time includes SQLite I/O; API time also includes preparation,
 * binding, queuing, result conversion and callback scheduling. Never subtract
 * interval totals as an exact handoff measurement: completion events can lag. */
export class SQLObserver {
	private calls = 0; private awaitMs = 0; private nativeCalls = 0; private nativeMs = 0; private maxMs = 0
	private active = new Map<number, number>(); private sequence = 0
	private owned: boolean
	private profile = (_sql: string, ms: number) => { if (Number.isFinite(ms) && ms >= 0) { this.nativeCalls++; this.nativeMs += ms } }
	constructor(private db: sqlite3.Database) {
		if (observers.has(db)) throw new Error('SQL diagnostics already active')
		this.owned = db.listenerCount('profile') === 0
		// sqlite3's on/removeListener overrides toggle native callbacks on every
		// listener. Use the base emitter to preserve other listeners correctly.
		if (this.owned) db.on('profile', this.profile)
		else EventEmitter.prototype.on.call(db, 'profile', this.profile)
		observers.set(db, this)
	}
	async measure<T>(operation: () => Promise<T>): Promise<T> {
		const id = this.sequence++, started = performance.now(); this.active.set(id, started)
		try { return await operation() } finally {
			const ms = performance.now() - started; this.active.delete(id)
			this.calls++; this.awaitMs += ms; this.maxMs = Math.max(this.maxMs, ms)
		}
	}
	snapshot(now = performance.now()): SQLSnapshot {
		const pending = [...this.active.values()].map(at => Math.max(0, now - at))
		return { calls: this.calls, awaitMs: this.awaitMs + pending.reduce((a, b) => a + b, 0), nativeCalls: this.nativeCalls, nativeMs: this.nativeMs, active: pending.length, oldestMs: Math.max(0, ...pending), maxMs: this.maxMs }
	}
	close() {
		if (observers.get(this.db) !== this) return
		observers.delete(this.db)
		if (this.db.listenerCount('profile') === 1) this.db.removeListener('profile', this.profile)
		else EventEmitter.prototype.removeListener.call(this.db, 'profile', this.profile)
	}
}
