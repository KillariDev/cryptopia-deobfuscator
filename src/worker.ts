import { config } from './config.js'
import { templates } from './strategies.js'
import { TemplateRule } from './templates.js'
import { parentPort } from 'worker_threads'
import { createOptimizerCaches, optimize } from './processing.js'
import { openRainbowPortfolio } from './rainbow-portfolio.js'
import { Gate } from './types.js'
import { WORKER_ROUND_MS } from './job.js'

let portfolio: ReturnType<typeof openRainbowPortfolio> | undefined
const caches = createOptimizerCaches()
let lastShared = performance.now()
parentPort!.on('message', async ({ gates, wires, stopSignal, budgetMs, sharedTemplates }: { sharedTemplates?: TemplateRule[], gates: Gate[], wires: number, stopSignal?: SharedArrayBuffer, budgetMs: number }) => {
	try {
		if (sharedTemplates !== undefined) {
			if (config.workers.shareTemplates) templates.importShared(sharedTemplates, config.workers.sharedTemplateBatch)
			return
		}
		// Open once per persistent worker and wait for every connection to be ready.
		const tables = await (portfolio ??= openRainbowPortfolio())
		let lastSnapshotCount = gates.length
		const stop = stopSignal ? new Int32Array(stopSignal) : undefined
		const result = await optimize(tables, gates, wires, 'worker', true, caches, Math.min(budgetMs, WORKER_ROUND_MS), (count, activity, candidate) => {
			const snapshot = count < lastSnapshotCount ? candidate : undefined
			if (snapshot) lastSnapshotCount = count
			const now = performance.now()
			const sharedTemplates = config.workers.shareTemplates && now - lastShared >= config.workers.sharedTemplateSeconds * 1000 ? templates.drainShared(config.workers.sharedTemplateBatch) : []
			if (sharedTemplates.length) lastShared = now
			parentPort!.postMessage({ progress: count, activity, snapshot, sharedTemplates })
		}, () => stop !== undefined && Atomics.load(stop, 0) !== 0, count => count < lastSnapshotCount)
		parentPort!.postMessage({ gates: result, sharedTemplates: config.workers.shareTemplates ? templates.drainShared(config.workers.sharedTemplateBatch) : [] })
	} catch (error) {
		parentPort!.postMessage({ error: String(error) })
	}
})
