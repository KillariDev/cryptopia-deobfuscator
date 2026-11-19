import { isReplacementSimpler } from './utils.js'
import type { CutPatch } from './dependency-cuts.js'
import { SearchProgress } from './search-progress.js'
import { config, minimumBroadGates } from './config.js'
import { Gate } from './types.js'
import { WorkerActivity } from './logging.js'
import { RainbowPortfolio } from './rainbow-portfolio.js'
import { broadStrategyOrder, createOptimizerCaches, massOptimizeStep, SubsetPreparation } from './processing.js'
import { strategySnapshot } from './strategy-stats.js'
import { structuralChoices, structuralNames } from './structural-strategies.js'

/** Coarse-to-fine windows with 50% overlap, interleaved so all scales get a turn. */
export function* broadRegions(length: number, minimum = 2): Generator<{ start: number, end: number }> {
	if (length < minimum) return
	yield { start: 0, end: length }
	const widths: number[] = []
	for (let width = Math.floor(length / 2); width >= minimum; width = Math.floor(width / 2)) widths.push(width)
	const offsets = widths.map(() => 0), finished = new Set<number>()
	while (finished.size < widths.length) for (let i = 0; i < widths.length; i++) {
		if (finished.has(i)) continue
		const width = widths[i], start = Math.min(offsets[i], length - width)
		yield { start, end: start + width }
		if (start === length - width) finished.add(i)
		else offsets[i] += Math.max(1, Math.floor(width / 2))
	}
}

const cursors = new WeakMap<object, { strategy: string, cursor: SearchProgress }>()

/** Search windows larger than the local search limits. */
export async function broadSearch(tables: RainbowPortfolio, input: Gate[], wires: number, caches: ReturnType<typeof createOptimizerCaches>, budgetMs: number, shouldStop: () => boolean, onProgress: (count: number, activity: WorkerActivity, snapshot?: Gate[]) => void): Promise<Gate[]> {
	const deadline = performance.now() + budgetMs
	const stopped = () => shouldStop() || performance.now() >= deadline
	const activity: WorkerActivity = { scope: 'broad', passes: 0, subsets: 0, checks: 0, improvements: 0, stage: 'searching' }
	const report = (snapshot?: Gate[], cutPatch?: CutPatch) => onProgress(snapshot?.length ?? input.length, { ...activity, cutPatch, activeStrategy: config.search.strategyAdaptive ? caches.broadStrategyPicker.activeStrategy : undefined, strategies: strategySnapshot().map(stat => ({ ...stat, strategy: ['gf2-affine-whole', 'symbolic-whole'].includes(stat.strategy) ? stat.strategy : `${stat.strategy} broad` })) }, snapshot)
	const minimum = minimumBroadGates()
	const structural = structuralChoices()
	const choices = broadStrategyOrder().filter(name => !(structuralNames as readonly string[]).includes(name) ||
		(structural as readonly string[]).includes(name)).map(name => ({ name }))
	if (input.length < minimum || !choices.length || stopped()) return input
	report()
	const strategy = config.search.strategyAdaptive ? caches.broadStrategyPicker.activeStrategy ?? '' : ''
	let state = cursors.get(caches)
	if (!state || state.strategy !== strategy) {
		state = { strategy, cursor: new SearchProgress() }
		cursors.set(caches, state)
	}
	const { cursor } = state
	cursor.reset(input, () => broadRegions(input.length, minimum))
	while (!stopped()) {
		const task = cursor.next(minimum, false)
		if (!task) break
		const { start, end, slice } = task
		if (slice < minimum) continue
		const picker = config.search.strategyAdaptive ? caches.broadStrategyPicker : caches.broadFallbackPicker
		const selected = picker.pick(choices)
		if (!selected) break
		const region = input.slice(start, end)
		activity.subsets++
		activity.passes++
		activity.checks++
		let cutPatch: CutPatch | undefined
		const next = await massOptimizeStep(tables, caches.ioIdentifierCache, caches.processedGatesCache, region, slice,
			config.search.probabilistic, false, false, new SubsetPreparation(region),
			{ deadline, shouldStop, broad: true, minimumBroadGates: minimum, selectedStrategy: selected.name, onProgress: () => report(), onCut: (indices, replacement) => { cutPatch = { indices: indices.map(index => index + start), replacement } } },
			caches.broadStrategyPicker)
		report()
		if (next.changed) {
			const result = [...input.slice(0, start), ...next.gates, ...input.slice(end)]
			if (!isReplacementSimpler(result, input)) continue
			activity.improvements++
			report(result, cutPatch)
			return result
		}
	}
	report()
	return input
}
