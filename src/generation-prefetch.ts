import { OperationTiming } from './generation-operations.js'
/** Ordered, byte-bounded lookahead. The source may also retain its own bounded
 * worker queue. A single oversized chunk is allowed so small budgets cannot
 * deadlock. Cancellation wakes both producers and consumers. */
export class GenerationPrefetch<T extends { waitMs: number }> {
	private queue: { value: T, bytes: number }[] = []
	private dataWaiters: (() => void)[] = []; private spaceWaiters: (() => void)[] = []
	private stopped = false; private finished = false; private error?: unknown; private failed = false
	bufferedBytes = 0; peakBytes = 0
	readonly settled: Promise<void>
	constructor(source: AsyncIterable<T>, private budget: number, size: (value: T) => number) {
		if (!Number.isSafeInteger(budget) || budget < 1) throw new Error('Invalid generation prefetch budget')
		this.settled = this.produce(source, size)
	}
	private wake(waiters: (() => void)[]) { for (const resolve of waiters.splice(0)) resolve() }
	private async produce(source: AsyncIterable<T>, size: (value: T) => number) {
		try {
			for await (const value of source) {
				const bytes = size(value)
				if (!Number.isSafeInteger(bytes) || bytes < 0) throw new Error('Invalid prefetch item size')
				while (!this.stopped && this.queue.length && this.bufferedBytes + bytes > this.budget) await new Promise<void>(resolve => this.spaceWaiters.push(resolve))
				if (this.stopped) break
				this.queue.push({ value, bytes }); this.bufferedBytes += bytes; this.peakBytes = Math.max(this.peakBytes, this.bufferedBytes)
				this.wake(this.dataWaiters)
			}
		} catch (error) { if (!this.stopped) { this.error = error; this.failed = true } }
		finally { this.finished = true; this.wake(this.dataWaiters) }
	}
	async *values(): AsyncGenerator<T> {
		try {
			while (!this.stopped) {
				const started = performance.now()
				while (!this.queue.length && !this.finished && !this.stopped) await new Promise<void>(resolve => this.dataWaiters.push(resolve))
				if (this.failed) throw this.error
				if (this.stopped) return
				const next = this.queue.shift()
				if (!next) return
				this.bufferedBytes -= next.bytes; this.wake(this.spaceWaiters)
				yield { ...next.value, waitMs: performance.now() - started }
			}
		} finally { if (!this.finished || this.queue.length) this.cancel() }
	}
	cancel() { this.stopped = true; this.queue = []; this.bufferedBytes = 0; this.wake(this.spaceWaiters); this.wake(this.dataWaiters) }
}
export type GenerationActivity = { running: number, queued: number, lookaheadBatches: number, bufferedBytes: number, bufferLimitBytes: number, stagingWriters?: number, activeStagingWriters?: number, stagingBufferedRows?: number, writerMs?: number, allBusyMs?: number, stagingRows?: number[], operations?: OperationTiming[] }
