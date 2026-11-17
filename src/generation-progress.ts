export type GenerationProfile = { phase: 'reading' | 'staging' | 'deduplicating' | 'writing lookup' | 'committing' | 'expanding' | 'complete', phaseStarted: number, stagingMs: number, dedupMs: number, outputMs: number, commitMs: number, elapsedMs: number, expansionMs: number, writeMs: number, readMs: number, waitMs: number, candidates: number, emitted: number, batches: number, workersUsed: number, peakPending: number }
export type SemanticProgress = { depth: number, processed: number, total: number, states: number, processedThisRun?: number, disk?: boolean, overallDone?: number, overallTotal?: number, overallEstimated?: boolean, complete?: boolean }
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
	overallEta(progress: SemanticProgress) {
		if (progress.overallDone === undefined || progress.overallTotal === undefined) return 'learning work size'
		if (progress.overallDone >= progress.overallTotal) return progress.complete ? '0s' : 'finishing'
		if (this.rates.length < this.warmup) return 'learning processing speed'
		if (!this.smoothed || this.rates.every(rate => rate === 0)) return 'unavailable (waiting for progress)'
		return `~${generationDuration((progress.overallTotal - progress.overallDone) / this.smoothed)}`
	}
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
export function formatGenerationProgress(progress: SemanticProgress | undefined, _elapsedMs: number, eta: string) {
	if (!progress || progress.overallDone === undefined || progress.overallTotal === undefined) return 'Rainbow generation: ~0.00% complete | ETA learning processing speed'
	const percent = !progress.complete && progress.overallDone >= progress.overallTotal ? '99.99%' : progressPercent(BigInt(Math.floor(progress.overallDone)), BigInt(Math.ceil(progress.overallTotal)))
	return `Rainbow generation: ${progress.overallEstimated ? '~' : ''}${percent} complete | ETA ${eta}`
}

export function formatGenerationProfile(profile: GenerationProfile, now = performance.now()) {
	const seconds = (ms: number) => `${(ms / 1000).toFixed(1)}s`
	return `Generation work: ${profile.phase}${profile.phase === 'complete' ? '' : ` (${generationDuration(now - profile.phaseStarted)})`} | expansion ${seconds(profile.expansionMs)} CPU | read ${seconds(profile.readMs)} | stage ${seconds(profile.stagingMs)} | deduplicate ${seconds(profile.dedupMs)} | lookup ${seconds(profile.outputMs)} | commit ${seconds(profile.commitMs)} | expansion wait ${seconds(profile.waitMs)}. Cumulative timings overlap.`
}

/** Input-row work estimate; future layer growth is projected, never claimed exact. */
export function overallGenerationWork(layers: { depth: number, total: number, processed: number }[], maximumDepth: number, complete = false, initialGrowth = 1) {
	const done = layers.reduce((sum, layer) => sum + layer.processed, 0)
	let total = layers.reduce((sum, layer) => sum + layer.total, 0)
	const last = layers[layers.length - 1], previous = layers[layers.length - 2]
	if (complete) return { overallDone: done, overallTotal: done, overallEstimated: false }
	if (!last) return {}
	const estimated = last.depth < maximumDepth - 1
	const growth = previous ? Math.max(1, last.total / Math.max(1, previous.total)) : Math.max(1, initialGrowth)
	let projected = last.total
	for (let depth = last.depth + 1; depth < maximumDepth; depth++) {
		projected = Math.min(Number.MAX_SAFE_INTEGER / Math.max(1, maximumDepth), projected * growth)
		total = Math.min(Number.MAX_SAFE_INTEGER, total + projected)
	}
	return { overallDone: done, overallTotal: Math.max(done, total), overallEstimated: estimated }
}
