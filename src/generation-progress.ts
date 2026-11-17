export type GenerationProfile = { phase: 'reading' | 'staging' | 'deduplicating' | 'writing lookup' | 'committing' | 'importing scratch' | 'expanding' | 'cleaning up' | 'compacting' | 'complete', phaseActive: boolean, phaseStarted: number, stagingMs: number, dedupMs: number, outputMs: number, commitMs: number, importMs: number, committedParents: number, elapsedMs: number, expansionMs: number, writeMs: number, readMs: number, waitMs: number, candidates: number, emitted: number, batches: number, workersUsed: number, peakPending: number }
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
const median = (values: number[]) => {
	const sorted = values.slice().sort((a, b) => a - b), middle = Math.floor(sorted.length / 2)
	return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2
}
export type EtaTrendOptions = { windowSamples: number, minimumSamples: number, minimumWorkGrowth: number }
/** Recent measured throughput by default; optional trend needs substantial history. */
export class GenerationEstimator {
	private depth = -1
	private done = 0
	private at = 0
	private rates: number[] = []
	private samples: { work: number, cost: number }[] = []
	private smoothed?: number
	constructor(private windowSize: number, private warmup: number, private smoothing: number, private maximumSlowdown = 1, private trend: EtaTrendOptions = { windowSamples: 60, minimumSamples: 10, minimumWorkGrowth: .25 }) {}

	/** Milliseconds, conditional on the supplied work projection; excludes final compaction. */
	remainingMs(progress: SemanticProgress): number | undefined {
		if (progress.overallDone === undefined || progress.overallTotal === undefined) return undefined
		return this.forecast(progress.overallTotal - progress.overallDone, Math.max(1, progress.processed))
	}
	private forecast(remaining: number, work: number): number | undefined {
		if (this.rates.length < this.warmup || !this.smoothed) return undefined
		const sorted = this.rates.slice().sort((a, b) => a - b)
		// Ignore one isolated slow interval once four samples exist; follow sustained slowdown immediately.
		const rate = Math.min(this.smoothed, sorted[Math.floor(sorted.length / 4)])
		if (!rate) return undefined
		const cost = 1 / rate, slopes: number[] = []
		const history = this.samples.filter(sample => Number.isFinite(sample.cost))
		const supported = this.maximumSlowdown > 1 && history.length >= this.trend.minimumSamples && history[history.length - 1].work / history[0].work >= 1 + this.trend.minimumWorkGrowth
		if (supported) for (let i = 0; i < history.length; i++) for (let j = i + 1; j < history.length; j++) {
			const a = history[i], b = history[j], distance = Math.log(b.work / a.work)
			if (!Number.isFinite(a.cost) || !Number.isFinite(b.cost)) continue
			if (distance > 0) slopes.push((b.cost - a.cost) / distance)
		}
		const slope = slopes.length ? Math.max(0, median(slopes)) : 0
		// Integrate cost + slope*log(future work/current work), instead of assuming constant speed.
		const ratio = Math.max(0, remaining) / Math.max(1, work)
		const averageLogGrowth = ratio < 0.0001 ? ratio / 2 : (1 + 1 / ratio) * Math.log1p(ratio) - 1
		const forecastCost = Math.min(cost * this.maximumSlowdown, cost + slope * averageLogGrowth)
		return Math.max(0, remaining) * forecastCost
	}
	overallEta(progress: SemanticProgress) {
		if (progress.overallDone === undefined || progress.overallTotal === undefined) return 'learning work size'
		if (progress.overallDone >= progress.overallTotal) return progress.complete ? '0s' : 'finishing'
		if (this.rates.length < this.warmup) return 'learning processing speed'
		const ms = this.remainingMs(progress)
		if (ms === undefined) return 'unavailable (waiting for progress)'
		return `~${generationDuration(ms)}${progress.overallEstimated ? ' (rough)' : ''}`
	}
	update(progress: SemanticProgress, now: number) {
		if (this.depth !== progress.depth) {
			this.depth = progress.depth; this.done = progress.processed; this.at = now; this.rates = []; this.samples = []; this.smoothed = undefined
		}
		const elapsed = now - this.at
		if (elapsed >= 1000) {
			const delta = Math.max(0, progress.processed - this.done), rate = delta / elapsed
			this.rates.push(rate)
			if (this.rates.length > this.windowSize) this.rates.shift()
			this.samples.push({ work: Math.max(1, (progress.processed + this.done) / 2), cost: rate ? 1 / rate : Infinity })
			if (this.samples.length > this.trend.windowSamples) this.samples.shift()
			const observed = median(this.rates)
			this.smoothed = this.smoothed === undefined ? observed : (1 - this.smoothing) * this.smoothed + this.smoothing * observed
			this.done = progress.processed; this.at = now
		}
		if (progress.processed >= progress.total) return '0s'
		if (this.rates.length < this.warmup) return 'learning processing speed'
		const ms = this.forecast(progress.total - progress.processed, Math.max(1, progress.processed))
		return ms === undefined ? 'unavailable (waiting for progress)' : `~${generationDuration(ms)}`
	}
}

export function formatGenerationProgress(progress: SemanticProgress | undefined, _elapsedMs: number, eta: string) {
	if (!progress || progress.overallDone === undefined || progress.overallTotal === undefined) return 'Rainbow generation: ~0.00% complete | ETA learning processing speed'
	const percent = !progress.complete && progress.overallDone >= progress.overallTotal ? '99.99%' : progressPercent(BigInt(Math.floor(progress.overallDone)), BigInt(Math.ceil(progress.overallTotal)))
	return `Rainbow generation: ${progress.overallEstimated ? '~' : ''}${percent} complete | ETA ${eta}`
}

export function formatGenerationProfile(profile: GenerationProfile, now = performance.now()) {
	const seconds = (ms: number) => `${(ms / 1000).toFixed(1)}s`
	return `Generation work: ${profile.phaseActive ? `${profile.phase} (${generationDuration(now - profile.phaseStarted)})` : profile.phase === 'complete' ? 'complete' : 'between operations'} | expansion ${seconds(profile.expansionMs)} worker-time | read ${seconds(profile.readMs)} | stage wait ${seconds(profile.stagingMs)} | scratch import ${seconds(profile.importMs)} | deduplicate ${seconds(profile.dedupMs)} | lookup ${seconds(profile.outputMs)} | commit ${seconds(profile.commitMs)} | expansion wait ${seconds(profile.waitMs)}. Cumulative timings overlap.`
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
