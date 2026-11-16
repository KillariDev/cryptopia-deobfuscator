export type SemanticProgress = { depth: number, processed: number, total: number, states: number, processedThisRun?: number, disk?: boolean }
export function progressPercent(done: bigint, total: bigint) {
	if (total <= 0n) return '0.00%'
	if (done >= total) return '100.00%'
	const hundredths = Number(done * 10000n / total)
	return hundredths === 0 && done > 0n ? '<0.01%' : `${(hundredths / 100).toFixed(2)}%`
}
export function generationDuration(ms: number) {
	if (!Number.isFinite(ms) || ms > 3650 * 86400000) return 'more than 10 years'
	const seconds = Math.max(0, Math.ceil(ms / 1000))
	if (seconds < 60) return `${seconds}s`
	if (seconds < 3600) return `${Math.floor(seconds / 60)}m ${seconds % 60}s`
	if (seconds < 86400) return `${Math.floor(seconds / 3600)}h ${Math.floor(seconds % 3600 / 60)}m`
	return `${Math.floor(seconds / 86400)}d ${Math.floor(seconds % 86400 / 3600)}h`
}
/** Layer-local rolling median suppresses spikes; EMA prevents abrupt rate changes. */
export class GenerationEstimator {
	private depth = -1
	private done = 0
	private at = 0
	private rates: number[] = []
	private smoothed?: number
	constructor(private windowSize: number, private warmup: number, private smoothing: number) {}
	update(progress: SemanticProgress, now: number) {
		if (this.depth !== progress.depth) {
			this.depth = progress.depth; this.done = progress.processed; this.at = now; this.rates = []; this.smoothed = undefined
		}
		const elapsed = now - this.at
		if (elapsed >= 1000) {
			this.rates.push(Math.max(0, progress.processed - this.done) / elapsed)
			if (this.rates.length > this.windowSize) this.rates.shift()
			const sorted = [...this.rates].sort((a, b) => a - b)
			const median = sorted[Math.floor(sorted.length / 2)]
			this.smoothed = this.smoothed === undefined ? median : (1 - this.smoothing) * this.smoothed + this.smoothing * median
			this.done = progress.processed; this.at = now
		}
		if (progress.processed >= progress.total) return '0s'
		if (this.rates.length < this.warmup) return 'learning processing speed'
		if (!this.smoothed || this.rates.every(rate => rate === 0)) return 'unavailable (waiting for progress)'
		return `~${generationDuration((progress.total - progress.processed) / this.smoothed)}`
	}
}
export function formatGenerationProgress(progress: SemanticProgress | undefined, elapsedMs: number, eta: string) {
	if (!progress) return 'Rainbow generation: preparing disk-backed search'
	return `Rainbow generation: depth ${progress.depth}, layer ${progressPercent(BigInt(progress.processed), BigInt(progress.total))} | layer ETA ${eta} | overall ETA unavailable (future layers are not known) | ${progress.states.toLocaleString('en-US')} functions indexed on disk; elapsed ${generationDuration(elapsedMs)}`
}
