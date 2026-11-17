import { StagingRow } from './generation-staging.js'
/** A single ordered consumer, with a bound including its active batch. Submissions
 * return on admission, not completion. finish/abort always settle active native
 * work before the caller commits or rolls back its transaction. */
export class GenerationStagingStream {
	private queue: StagingRow[][] = []
	private active = false
	private accepting = true
	private aborted = false
	private failed = false
	private error?: unknown
	private running?: Promise<void>
	private waiters: (() => void)[] = []
	peakBatches = 0
	constructor(readonly capacity: number, private write: (rows: StagingRow[]) => Promise<void>) {
		if (!Number.isSafeInteger(capacity) || capacity < 1) throw new Error('Invalid staging stream capacity')
	}
	get batches() { return this.queue.length + (this.active ? 1 : 0) }
	private wake() { for (const resolve of this.waiters.splice(0)) resolve() }
	async submit(rows: StagingRow[]) {
		while (this.accepting && !this.failed && this.batches >= this.capacity) await new Promise<void>(resolve => this.waiters.push(resolve))
		if (this.failed) throw this.error
		if (!this.accepting) throw new Error('Staging stream is closed')
		if (!rows.length) return
		this.queue.push(rows); this.peakBatches = Math.max(this.peakBatches, this.batches)
		this.start()
	}
	private start() {
		if (this.running) return
		// Schedule before entering user code: synchronous failures cannot race
		// assignment of the promise, and all rejections are handled immediately.
		this.running = Promise.resolve().then(async () => {
			try {
				while (this.queue.length && !this.aborted) {
					const rows = this.queue.shift()!; this.active = true
					try { await this.write(rows) } finally { this.active = false; this.wake() }
				}
			} catch (error) { this.failed = true; this.error = error; this.accepting = false; this.queue = []; this.wake() }
		}).finally(() => {
			this.running = undefined
			if (this.queue.length && !this.aborted && !this.failed) this.start()
		})
	}
	async finish() {
		this.accepting = false; this.wake()
		while (this.running) await this.running
		if (this.failed) throw this.error
	}
	async abort() {
		this.accepting = false; this.aborted = true; this.queue = []; this.wake()
		while (this.running) await this.running
	}
}
