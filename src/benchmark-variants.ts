import { SolverConfig } from './config.js'

export const comparisonVariants = ['reference', 'tuned'] as const
export const ablationVariants = ['reference', 'shared-tables', 'components', 'stable-arms', 'decay', 'lru', 'tuned'] as const
export const benchmarkVariantNames = [...ablationVariants, 'tuned-no-stable', 'tuned-conservative'] as const
export type BenchmarkVariant = typeof benchmarkVariantNames[number]

/** Single-feature variants differ from the same reference by exactly one control. */
export function benchmarkSettings(base: SolverConfig, variant: BenchmarkVariant): SolverConfig {
	const settings = structuredClone(base)
	settings.workers.adaptiveConcurrency = false
	if (variant === 'tuned' || variant === 'tuned-no-stable' || variant === 'tuned-conservative') {
		if (variant !== 'tuned') settings.search.stableSearchArms = false
		if (variant === 'tuned-conservative') settings.search.independentComponents = false
		return settings
	}
	settings.database.sharedTables = false; settings.search.independentComponents = false
	settings.search.stableSearchArms = false; settings.search.schedulerDecay = 1; settings.cache.lookupPolicy = 'fifo'
	if (variant === 'shared-tables') settings.database.sharedTables = true
	if (variant === 'components') settings.search.independentComponents = true
	if (variant === 'stable-arms') settings.search.stableSearchArms = true
	if (variant === 'decay') settings.search.schedulerDecay = base.benchmark.decayFactor
	if (variant === 'lru') settings.cache.lookupPolicy = 'lru'
	return settings
}

export function benchmarkOrder(variants: readonly BenchmarkVariant[], repeat: number, workerIndex: number): BenchmarkVariant[] {
	const ordered = repeat % 2 ? [...variants].reverse() : [...variants]
	const offset = (repeat + workerIndex) % ordered.length
	return [...ordered.slice(offset), ...ordered.slice(0, offset)]
}
