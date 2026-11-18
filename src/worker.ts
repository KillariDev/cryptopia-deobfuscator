import { broadSearch } from './broad-search.js'
import { recordStrategy, resetStrategyStats, strategySnapshot } from './strategy-stats.js'
import { config } from './config.js'
import { templates, wholeCircuitAffineSearch } from './strategies.js'
import { TemplateRule } from './templates.js'
import { parentPort, workerData } from 'worker_threads'
import { createOptimizerCaches, optimize, shuffleRowsWithDependentGateSwap } from './processing.js'
import { openRainbowPortfolio } from './rainbow-portfolio.js'
import { Gate } from './types.js'
import { WORKER_ROUND_MS } from './job.js'

let portfolio: ReturnType<typeof openRainbowPortfolio> | undefined
const caches = createOptimizerCaches()
let lastShared = performance.now()
parentPort!.on('message', async ({ gates, wires, stopSignal, budgetMs, solver = 'local', restartOnImprovement = false, sharedTemplates }: { sharedTemplates?: TemplateRule[], gates: Gate[], wires: number, stopSignal?: SharedArrayBuffer, budgetMs: number, restartOnImprovement?: boolean, solver?: 'local' | 'affine' | 'broad' | 'shuffle' }) => {
	try {
		if (sharedTemplates !== undefined) {
			if (config.workers.shareTemplates) templates.importShared(sharedTemplates, config.workers.sharedTemplateBatch)
			return
		}
		if (solver === 'shuffle') {
			resetStrategyStats()
			const started = performance.now(), deadline = started + budgetMs
			const stop = stopSignal ? new Int32Array(stopSignal) : undefined
			shuffleRowsWithDependentGateSwap(gates, config.search.roundShufflePasses, () => performance.now() >= deadline || (stop !== undefined && Atomics.load(stop, 0) !== 0))
			recordStrategy('shuffle', { passes: config.search.roundShufflePasses }, started, gates.length, gates.length, false)
			parentPort!.postMessage({ gates, activity: { passes: 0, subsets: 0, checks: 0, improvements: 0, stage: 'shuffling', strategies: strategySnapshot() } })
			return
		}
		if (solver === 'affine') {
			resetStrategyStats()
			const stop = stopSignal ? new Int32Array(stopSignal) : undefined
			const result = wholeCircuitAffineSearch(gates, budgetMs, () => stop !== undefined && Atomics.load(stop, 0) !== 0)
			parentPort!.postMessage({ gates: result, activity: { passes: 1, subsets: 1, checks: 1, improvements: Number(result.length < gates.length), stage: 'verifying', strategies: strategySnapshot() } })
			return
		}
		// Open once per persistent worker and wait for every connection to be ready.
		const tables = await (portfolio ??= openRainbowPortfolio(config.database.tables, workerData?.sharedTables ?? []))
		if (solver === 'broad') {
			resetStrategyStats()
			const stop = stopSignal ? new Int32Array(stopSignal) : undefined
			const result = await broadSearch(tables, gates, wires, caches, budgetMs, () => stop !== undefined && Atomics.load(stop, 0) !== 0, (progress, activity, snapshot) => parentPort!.postMessage({ progress, activity, snapshot }))
			parentPort!.postMessage({ gates: result })
			return
		}
		let lastSnapshotCount = gates.length
		const stop = stopSignal ? new Int32Array(stopSignal) : undefined
		const result = await optimize(tables, gates, wires, 'worker', true, caches, Math.min(budgetMs, WORKER_ROUND_MS), (count, activity, candidate) => {
			const snapshot = count < lastSnapshotCount ? candidate : undefined
			if (snapshot) lastSnapshotCount = count
			const now = performance.now()
			const sharedTemplates = config.workers.shareTemplates && now - lastShared >= config.workers.sharedTemplateSeconds * 1000 ? templates.drainShared(config.workers.sharedTemplateBatch) : []
			if (sharedTemplates.length) lastShared = now
			parentPort!.postMessage({ progress: count, activity, snapshot, sharedTemplates })
		}, activity => (restartOnImprovement && lastSnapshotCount < gates.length) || (stop !== undefined && Atomics.load(stop, 0) !== 0) || (workerData?.maximumChecks > 0 && (activity?.checks ?? 0) >= workerData.maximumChecks), count => count < lastSnapshotCount, restartOnImprovement)
		parentPort!.postMessage({ gates: result, sharedTemplates: config.workers.shareTemplates ? templates.drainShared(config.workers.sharedTemplateBatch) : [] })
	} catch (error) {
		parentPort!.postMessage({ error: String(error) })
	}
})
