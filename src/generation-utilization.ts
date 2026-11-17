/** Integrate writer-operation occupancy, not CPU utilization. Monotonic cumulative
 * counters include currently running operations, so sampling at batch boundaries
 * or in the middle of a long call measures the same interval. */
export type WriterSnapshot = { writerMs: number, allBusyMs: number }
export class WriterUtilization {
	private active = 0
	private at: number
	private writerMs = 0
	private allBusyMs = 0
	constructor(readonly slots: number, private now = () => performance.now()) {
		if (!Number.isSafeInteger(slots) || slots < 1) throw new Error('Invalid writer slot count')
		this.at = now()
	}
	get activeCount() { return this.active }
	private advance() {
		const now = this.now(), elapsed = Math.max(0, now - this.at)
		this.writerMs += elapsed * this.active
		if (this.active === this.slots) this.allBusyMs += elapsed
		this.at = now
	}
	async measure<T>(operation: () => Promise<T>): Promise<T> {
		this.advance(); this.active++
		try { return await operation() } finally { this.advance(); this.active-- }
	}
	snapshot(): WriterSnapshot { this.advance(); return { writerMs: this.writerMs, allBusyMs: this.allBusyMs } }
}
