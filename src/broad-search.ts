import { isBetterCircuit } from './circuit-cost.js'
import type { CutPatch } from './dependency-cuts.js'
import { SearchProgress } from './search-progress.js'
import { config, minimumBroadGates } from './config.js'
import { Gate } from './types.js'
import { WorkerActivity } from './logging.js'
import { RainbowPortfolio } from './rainbow-portfolio.js'
import { broadStrategyOrder, createOptimizerCaches, massOptimizeStep, SubsetPreparation } from './processing.js'
import { strategySnapshot } from './strategy-stats.js'
import { structuralChoices, structuralNames } from './structural-strategies.js'
import { polynomialShearRegions } from './polynomial-shear.js'
import { hashGates } from './utils.js'

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

const cursors = new WeakMap<object, Map<string, SearchProgress>>()

/** Search windows larger than the local search limits. */
export async function broadSearch(tables: RainbowPortfolio, input: Gate[], wires: number, caches: ReturnType<typeof createOptimizerCaches>, budgetMs: number, shouldStop: () => boolean, onProgress: (count: number, activity: WorkerActivity, snapshot?: Gate[]) => void): Promise<Gate[]> {
	const deadline = performance.now() + budgetMs
	const stopped = () => shouldStop() || performance.now() >= deadline
	const activity: WorkerActivity = { scope: 'broad', passes: 0, subsets: 0, checks: 0, improvements: 0, stage: 'searching' }
	const report = (snapshot?: Gate[], cutPatch?: CutPatch) => onProgress(snapshot?.length ?? input.length, { ...activity, cutPatch, activeStrategy: config.search.strategyAdaptive ? caches.broadStrategyPicker.activeStrategy : undefined, strategies: strategySnapshot().map(stat => ({ ...stat, strategy: ['gf2-affine-whole', 'polynomial-region-search'].includes(stat.strategy) ? stat.strategy : `${stat.strategy} broad` })) }, snapshot)
	const minimum = minimumBroadGates()
	const structural = structuralChoices()
	const assigned = config.search.strategyAdaptive ? caches.broadStrategyPicker.activeStrategy : undefined
	const choices = broadStrategyOrder().filter(name => (!config.search.strategyAdaptive || name === assigned) &&
		(!(structuralNames as readonly string[]).includes(name) || (structural as readonly string[]).includes(name))).map(name => ({ name }))
	if (input.length < minimum || !choices.length || stopped()) return input
	report()
	let state = cursors.get(caches)
	if (!state) {
		state = new Map()
		cursors.set(caches, state)
	}
	const length = input.length
	const key = `${minimum}:${hashGates(input)}`
	const passes = choices.map(({ name }) => {
		const shear = name === 'polynomial-shear-interpolation'
		const minimumWindow = shear ? 2 : minimum
		let cursor = state.get(name)
		if (!cursor) { cursor = new SearchProgress(); state.set(name, cursor) }
		cursor.reset(input, function* () {
			const regions = broadRegions(length, minimum)
			yield { start: 0, end: length }
			regions.next()
			const seen = new Set<string>()
			if (shear) {
				for (const region of polynomialShearRegions(input, wires, minimum)) {
					seen.add(`${region.start}:${region.end}`)
					yield region
				}
			}
			for (const region of regions) {
				const id = `${region.start}:${region.end}`
				if (seen.has(id)) continue
				if (shear) seen.add(id)
				yield region
			}
			if (shear) {
				// Fill the gaps lazily so a worker can resume on its next job.
				for (let width = minimumWindow; width < length; width++) {
					for (let start = 0; start + width <= length; start++) {
						const end = start + width
						if (!seen.has(`${start}:${end}`)) yield { start, end }
					}
				}
			}
		}, key)
		return { name, cursor, minimumWindow }
	})
	const remaining = passes.slice()
	while (!stopped()) {
		const selected = caches.broadFallbackPicker.pick(remaining)
		if (!selected) break
		const task = selected.cursor.next(selected.minimumWindow, false)
		if (!task) { remaining.splice(remaining.indexOf(selected), 1); continue }
		const { start, end, slice } = task
		if (slice < selected.minimumWindow) continue
		const region = input.slice(start, end)
		activity.subsets++
		activity.passes++
		activity.checks++
		let cutPatch: CutPatch | undefined
		const next = await massOptimizeStep(tables, caches.ioIdentifierCache, caches.processedGatesCache, region, slice,
			config.search.probabilistic, false, false, new SubsetPreparation(region),
			{ deadline, shouldStop, broad: true, minimumBroadGates: selected.minimumWindow, selectedStrategy: selected.name, onProgress: () => report(), onCut: (indices, replacement) => { cutPatch = { indices: indices.map(index => index + start), replacement } } },
			caches.broadStrategyPicker)
		if (!next.changed && stopped()) selected.cursor.retry(task)
		report()
		if (next.changed) {
			const result = [...input.slice(0, start), ...next.gates, ...input.slice(end)]
			if (!isBetterCircuit(result, input)) continue
			activity.improvements++
			report(result, cutPatch)
			return result
		}
	}
	activity.broadExhausted = passes.every(({ cursor }) => cursor.exhausted)
	report()
	return input
}
