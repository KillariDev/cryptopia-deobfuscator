import { config } from './config.js'
import { Gate } from './types.js'
import { WorkerActivity } from './logging.js'
import { RainbowPortfolio } from './rainbow-portfolio.js'
import { createOptimizerCaches, massOptimizeStep, SubsetPreparation } from './processing.js'
import { wholeCircuitAffineSearch } from './strategies.js'
import { strategySnapshot } from './strategy-stats.js'

/** Coarse-to-fine windows with 50% overlap, interleaved so all scales get a turn. */
export function* broadRegions(length: number): Generator<{ start: number, end: number }> {
	if (!length) return
	yield { start: 0, end: length }
	const widths: number[] = []
	for (let width = Math.floor(length / 2); width >= 2; width = Math.floor(width / 2)) widths.push(width)
	const offsets = widths.map(() => 0), finished = new Set<number>()
	while (finished.size < widths.length) for (let i = 0; i < widths.length; i++) {
		if (finished.has(i)) continue
		const width = widths[i], start = Math.min(offsets[i], length - width)
		yield { start, end: start + width }
		if (start === length - width) finished.add(i)
		else offsets[i] += Math.max(1, Math.floor(width / 2))
	}
}

/** Same toolkit as local search, with larger contexts and scan widths. */
export async function broadSearch(tables: RainbowPortfolio, input: Gate[], wires: number, caches: ReturnType<typeof createOptimizerCaches>, budgetMs: number, shouldStop: () => boolean, onProgress: (count: number, activity: WorkerActivity, snapshot?: Gate[]) => void): Promise<Gate[]> {
	const deadline = performance.now() + budgetMs
	const stopped = () => shouldStop() || performance.now() >= deadline
	const activity: WorkerActivity = { scope: 'broad', passes: 0, subsets: 0, checks: 0, improvements: 0, stage: 'searching' }
	const report = (snapshot?: Gate[]) => onProgress(snapshot?.length ?? input.length, { ...activity, strategies: strategySnapshot().map(stat => ({ ...stat, strategy: stat.strategy === 'gf2-affine-whole' ? stat.strategy : `${stat.strategy} broad` })) }, snapshot)
	report()
	for (const { start, end } of broadRegions(input.length)) {
		if (stopped()) break
		activity.subsets++
		const region = input.slice(start, end)
		if (config.synthesis.affine) {
			const affine = wholeCircuitAffineSearch(region, Math.max(0, deadline - performance.now()), stopped)
			report()
			if (affine.length < region.length) {
				activity.improvements++
				const result = [...input.slice(0, start), ...affine, ...input.slice(end)]
				report(result); return result
			}
		}
		const preparation = new SubsetPreparation(region)
		// Large windows first: variables and rainbow lookup get the full region,
		// then progressively smaller scans, rather than the local slice cap.
		for (let slice = region.length; slice >= config.search.sliceMinimum; slice = Math.floor(slice / 2)) {
			if (stopped()) break
			activity.passes++; activity.checks++
			const next = await massOptimizeStep(tables, caches.ioIdentifierCache, caches.processedGatesCache, region, slice, config.search.probabilistic, config.search.variableElimination, true, preparation, { deadline, shouldStop })
			report()
			if (next.changed && next.gates.length < region.length) {
				activity.improvements++
				const result = [...input.slice(0, start), ...next.gates, ...input.slice(end)]
				report(result); return result
			}
		}
	}
	return input
}
