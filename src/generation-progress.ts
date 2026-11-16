export function sequenceSpace(branches: number, maximumDepth: number) {
	const sizes = [1n]
	for (let depth = 1; depth <= maximumDepth; depth++) sizes.push(1n + BigInt(branches) * sizes[depth - 1])
	return sizes
}
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
export function generationETA(done: bigint, total: bigint, elapsedMs: number) {
	if (done >= total) return '0s'
	if (done === 0n || elapsedMs < 1000) return 'learning processing speed'
	const fractionLeft = Number((total - done) * 1000000n / done) / 1000000
	return `~${generationDuration(fractionLeft * elapsedMs)}`
}
export type SequenceProgress = { covered: bigint, total: bigint, examined: number, evaluated: number, pruned: bigint }
export type SemanticProgress = { depth: number, processed: number, total: number, states: number }
export function formatGenerationProgress(sequence: SequenceProgress | undefined, semantic: SemanticProgress | undefined, buffered: number, elapsedMs: number, writing: boolean, totalElapsedMs = elapsedMs, sampledETA?: string) {
	const suffix = `${buffered.toLocaleString('en-US')} functions buffered; elapsed ${generationDuration(totalElapsedMs)}`
	if (sequence) return `Rainbow generation: ${progressPercent(sequence.covered, sequence.total)} of sequence space accounted for | ${writing ? 'writing database; write ETA unavailable' : `search ETA ${sampledETA ?? generationETA(sequence.covered, sequence.total, elapsedMs)}`} | ${suffix}`
	if (semantic) return `Rainbow generation: depth ${semantic.depth}, layer ${progressPercent(BigInt(semantic.processed), BigInt(semantic.total))} | ${writing ? 'writing database' : `layer ETA ${generationETA(BigInt(semantic.processed), BigInt(semantic.total), elapsedMs)}`} | overall ETA unavailable (future layers are not known) | ${suffix}`
	return `Rainbow generation: preparing search | ${suffix}`
}
