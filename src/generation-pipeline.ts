import { ExpansionKernel, ExpansionParent, ExpansionResult, packParents } from './generation-expansion.js'
import { GenerationPool } from './generation-pool.js'

export type ExpansionChunk<T> = { parents: T[], result: ExpansionResult, waitMs: number }
export type PipelineOptions = { stageRows: number, workers: number, queueBatches: number, minimumWork: number }
type Chunk<T> = { parents: T[], gateStart: number, gateEnd: number }
function* chunks<T>(entries: T[], gates: number, maximum: number): Generator<Chunk<T>> {
	if (!gates) return
	if (gates > maximum) {
		for (const entry of entries) for (let start = 0; start < gates; start += maximum) yield { parents: [entry], gateStart: start, gateEnd: Math.min(gates, start + maximum) }
	} else {
		const count = Math.max(1, Math.floor(maximum / gates))
		for (let start = 0; start < entries.length; start += count) yield { parents: entries.slice(start, start + count), gateStart: 0, gateEnd: gates }
	}
}

/** Consume in submission order even when workers finish out of order. */
export async function* expandBatch<T extends ExpansionParent>(entries: T[], gateCount: number, kernel: ExpansionKernel, pool: GenerationPool, options: PipelineOptions,
	onPending?: (count: number) => void): AsyncGenerator<ExpansionChunk<T>> {
	const iterator = chunks(entries, gateCount, options.stageRows)
	if (options.workers === 1 || entries.length * gateCount < options.minimumWork) {
		for (const chunk of iterator) yield { parents: chunk.parents, result: kernel.expand({ ...chunk, parents: packParents(chunk.parents, kernel.stateBytes) }), waitMs: 0 }
		return
	}
	type Settled = { result: ExpansionResult } | { error: unknown }
	const pending: { parents: T[], result: Promise<Settled> }[] = []
	const fill = () => {
		while (pending.length < options.workers * options.queueBatches) {
			const next = iterator.next()
			if (next.done) break
			const chunk = next.value
			// Attach both handlers immediately: a later job may fail while the writer is busy.
			const result = pool.run({ ...chunk, parents: packParents(chunk.parents, kernel.stateBytes) })
				.then(result => ({ result }), error => ({ error }))
			pending.push({ parents: chunk.parents, result })
			onPending?.(pending.length)
		}
	}
	fill()
	while (pending.length) {
		const job = pending.shift()!, started = performance.now(), settled = await job.result
		if ('error' in settled) throw settled.error
		const waitMs = performance.now() - started
		// Refill before the writer stages this result; keep CPU work overlapping SQLite.
		fill()
		yield { parents: job.parents, result: settled.result, waitMs }
	}
}
