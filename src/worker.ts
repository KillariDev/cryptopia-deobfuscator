import { parentPort } from 'worker_threads'
import { createOptimizerCaches, optimize } from './processing.js'
import { getRainbowTable, databaseReady, RAINBOW_TABLE_GATES, RAINBOW_TABLE_WIRES } from './rainbowtable.js'
import { Gate } from './types.js'
import { WORKER_ROUND_MS } from './job.js'

const db = getRainbowTable(RAINBOW_TABLE_WIRES, RAINBOW_TABLE_GATES)
const ready = databaseReady(db)
const caches = createOptimizerCaches()
parentPort!.on('message', async ({ gates, wires, stopSignal, budgetMs }: { gates: Gate[], wires: number, stopSignal?: SharedArrayBuffer, budgetMs: number }) => {
	try {
		// Even an empty job must wait for SQLite's native open callback before
		// reporting completion, so shutdown cannot race database initialization.
		await ready
		let lastSnapshotCount = gates.length
		const stop = stopSignal ? new Int32Array(stopSignal) : undefined
		const result = await optimize(db, gates, wires, 'worker', true, RAINBOW_TABLE_WIRES, caches, Math.min(budgetMs, WORKER_ROUND_MS), (count, activity, candidate) => {
			const snapshot = count < lastSnapshotCount ? candidate : undefined
			if (snapshot) lastSnapshotCount = count
			parentPort!.postMessage({ progress: count, activity, snapshot })
		}, () => stop !== undefined && Atomics.load(stop, 0) !== 0, count => count < lastSnapshotCount)
		parentPort!.postMessage({ gates: result })
	} catch (error) {
		parentPort!.postMessage({ error: String(error) })
	}
})
