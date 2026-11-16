import { parentPort } from 'worker_threads'
import { createOptimizerCaches, optimize } from './processing.js'
import { getRainbowTable, RAINBOW_TABLE_GATES, RAINBOW_TABLE_WIRES } from './rainbowtable.js'
import { Gate } from './types.js'
import { WORKER_ROUND_MS } from './job.js'

const db = getRainbowTable(RAINBOW_TABLE_WIRES, RAINBOW_TABLE_GATES)
const ready = new Promise<void>((resolve, reject) => {
	db.once('open', resolve)
	db.once('error', reject)
})
const caches = createOptimizerCaches()
parentPort!.on('message', async ({ gates, wires }: { gates: Gate[], wires: number }) => {
	try {
		// Even an empty job must wait for SQLite's native open callback before
		// reporting completion, so shutdown cannot race database initialization.
		await ready
		const result = await optimize(db, gates, wires, 'worker', true, RAINBOW_TABLE_WIRES, caches, WORKER_ROUND_MS, count => parentPort!.postMessage({ progress: count }))
		parentPort!.postMessage({ gates: result })
	} catch (error) {
		parentPort!.postMessage({ error: String(error) })
	}
})
