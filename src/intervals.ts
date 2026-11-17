/** Half-open ranges; maximize removed gates, then local wire/read savings. */
export type WeightedInterval = { start: number, end: number, removed: number, wireSavings: number, readSavings: number }
type Score = [number, number, number]
const better = (a: Score, b: Score) => a[0] !== b[0] ? a[0] > b[0] : a[1] !== b[1] ? a[1] > b[1] : a[2] > b[2]
export function selectIntervals<T extends WeightedInterval>(input: T[]): T[] {
	const sorted = input.map((value, index) => ({ value, index })).sort((a, b) => a.value.end - b.value.end || a.value.start - b.value.start || a.index - b.index)
	const scores: Score[] = [[0, 0, 0]], previous: number[] = [], chosen: boolean[] = []
	for (let i = 0; i < sorted.length; i++) {
		const current = sorted[i].value
		if (current.end <= current.start) throw new Error('Invalid replacement interval')
		let low = 0, high = i
		while (low < high) { const middle = (low + high) >>> 1; if (sorted[middle].value.end <= current.start) low = middle + 1; else high = middle }
		previous[i] = low
		const prefix = scores[low], next: Score = [prefix[0] + current.removed, prefix[1] + current.wireSavings, prefix[2] + current.readSavings]
		chosen[i] = better(next, scores[i])
		scores.push(chosen[i] ? next : scores[i])
	}
	const result: T[] = []
	for (let i = sorted.length; i > 0;) {
		if (chosen[i - 1]) { result.push(sorted[i - 1].value); i = previous[i - 1] }
		else i--
	}
	return result.reverse()
}
