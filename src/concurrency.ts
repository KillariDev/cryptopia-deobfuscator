import { totalmem } from 'os'

type Observation = { concurrency: number, elapsedMs: number, removed: number, databaseMs: number, workerMs: number, memoryPressure: number }
/** Between-round hill climbing; resource pressure overrides throughput experiments. */
export class AdaptiveConcurrency {
	private target: number
	private samples = 0
	private elapsed = 0
	private removed = 0
	private database = 0
	private worker = 0
	private baseline?: { limit: number, rate: number }
	private direction = 1
	private cooldown = 0
	constructor(private maximum: number, initial: number, private sampleRounds: number, private databaseFraction: number, private tolerance: number) {
		this.target = Math.max(1, Math.min(maximum, initial))
	}
	limit(cap: number) { return Math.max(1, Math.min(cap, this.target)) }
	private reset() { this.samples = 0; this.elapsed = 0; this.removed = 0; this.database = 0; this.worker = 0 }
	observe(value: Observation): string | undefined {
		if (value.memoryPressure >= 1) {
			const next = Math.max(1, Math.floor(value.concurrency / 2))
			this.reset(); this.baseline = undefined
			if (next !== this.target) { this.target = next; return 'memory budget pressure' }
			return
		}
		// Small-circuit caps do not constitute a trial of the requested limit.
		if (value.concurrency !== this.target) { this.reset(); return }
		this.samples++; this.elapsed += value.elapsedMs; this.removed += Math.max(0, value.removed)
		this.database += value.databaseMs; this.worker += value.workerMs
		if (this.samples < this.sampleRounds) return
		const rate = this.removed / Math.max(1, this.elapsed), databaseFraction = this.database / Math.max(1, this.worker)
		this.reset()
		if (databaseFraction > this.databaseFraction && this.target > 1) {
			this.target--; this.baseline = undefined; return 'database wait pressure'
		}
		if (this.baseline && this.target !== this.baseline.limit) {
			const threshold = this.target < this.baseline.limit ? 1 - this.tolerance : 1 + this.tolerance
			const acceptable = this.target < this.baseline.limit ? rate >= this.baseline.rate * threshold : rate > this.baseline.rate * threshold
			if (!acceptable) {
				this.target = this.baseline.limit; this.direction *= -1; this.cooldown = 1
				return 'throughput trial did not improve productivity'
			}
		}
		if (rate === 0) return // No evidence for a throughput-driven increase.
		this.baseline = { limit: this.target, rate }
		if (this.cooldown) { this.cooldown--; return }
		if (this.target + this.direction < 1 || this.target + this.direction > this.maximum) this.direction *= -1
		const next = Math.max(1, Math.min(this.maximum, this.target + this.direction))
		if (next !== this.target) { this.target = next; return 'bounded throughput trial' }
	}
}

export function memoryPressure(budgetMegabytes: number) {
	const constrained = typeof process.constrainedMemory === 'function' ? process.constrainedMemory() : 0
	const availableBudget = Math.min(budgetMegabytes * 1048576, totalmem() * 0.8, constrained > 0 ? constrained * 0.8 : Infinity)
	return process.memoryUsage().rss / Math.max(1, availableBudget)
}
