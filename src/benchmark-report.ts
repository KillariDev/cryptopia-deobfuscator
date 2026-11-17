export type BenchmarkResult = { repeat: number, variant: string, workers: number, gatesPerSecond: number, removed: number, peakRssBytes: number, wallMs: number }
const median = (values: number[]) => {
	const sorted = values.slice().sort((a, b) => a - b), middle = Math.floor(sorted.length / 2)
	return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2
}

/** Pair by repetition/worker count; zero-progress baselines have no rate ratio. */
export function summarizeBenchmarks(results: BenchmarkResult[]) {
	const groups = new Map<string, BenchmarkResult[]>()
	for (const result of results) {
		const key = `${result.workers}:${result.variant}`, group = groups.get(key) ?? []
		group.push(result); groups.set(key, group)
	}
	return [...groups.values()].map(group => {
		const rates = group.map(row => row.gatesPerSecond)
		const pairedRatios = group.flatMap(row => {
			const reference = results.find(candidate => candidate.variant === 'reference' && candidate.workers === row.workers && candidate.repeat === row.repeat)
			return reference && reference.gatesPerSecond > 0 ? [row.gatesPerSecond / reference.gatesPerSecond] : []
		})
		return { workers: group[0].workers, variant: group[0].variant, repetitions: group.length, medianGatesPerSecond: median(rates), minGatesPerSecond: Math.min(...rates), maxGatesPerSecond: Math.max(...rates), medianRemoved: median(group.map(row => row.removed)), medianRssMiB: median(group.map(row => row.peakRssBytes / 1048576)), medianWallMs: median(group.map(row => row.wallMs)), pairedReferenceRatios: pairedRatios, medianPairedReferenceRatio: pairedRatios.length ? median(pairedRatios) : null }
	}).sort((a, b) => a.workers - b.workers || a.variant.localeCompare(b.variant))
}
