import { parentPort } from 'worker_threads'
import { createOptimizerCaches, optimize } from './processing.js'
import { openRainbowPortfolio } from './rainbow-portfolio.js'
import { Gate } from './types.js'
import { WORKER_ROUND_MS } from './job.js'

let portfolio: ReturnType<typeof openRainbowPortfolio> | undefined
const caches = createOptimizerCaches()
parentPort!.on('message', async ({ gates, wires, stopSignal, budgetMs }: { gates: Gate[], wires: number, stopSignal?: SharedArrayBuffer, budgetMs: number }) => {
	try {
		// Open once per persistent worker and wait for every connection to be ready.
		const tables = await (portfolio ??= openRainbowPortfolio())
		let lastSnapshotCount = gates.length
		const stop = stopSignal ? new Int32Array(stopSignal) : undefined
		const result = await optimize(tables, gates, wires, 'worker', true, caches, Math.min(budgetMs, WORKER_ROUND_MS), (count, activity, candidate) => {
			const snapshot = count < lastSnapshotCount ? candidate : undefined
			if (snapshot) lastSnapshotCount = count
			parentPort!.postMessage({ progress: count, activity, snapshot })
		}, () => stop !== undefined && Atomics.load(stop, 0) !== 0, count => count < lastSnapshotCount)
		parentPort!.postMessage({ gates: result })
	} catch (error) {
		parentPort!.postMessage({ error: String(error) })
	}
})
