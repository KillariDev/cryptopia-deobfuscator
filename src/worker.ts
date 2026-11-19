import { isBetterCircuit } from './circuit-cost.js'
import { broadSearch } from './broad-search.js'
import { recordStrategy, resetStrategyStats, strategySnapshot } from './strategy-stats.js'
import { config } from './config.js'
import { wholeCircuitAffineSearch } from './strategies.js'
import { parentPort, workerData } from 'worker_threads'
import { createOptimizerCaches, optimize, shuffleRowsWithDependentGateSwap } from './processing.js'
import { openRainbowPortfolio } from './rainbow-portfolio.js'
import { Gate } from './types.js'
import { WORKER_ROUND_MS } from './job.js'

let portfolio: ReturnType<typeof openRainbowPortfolio> | undefined
const caches = createOptimizerCaches(workerData?.workerIndex ?? 0)
parentPort!.on('message', async ({ gates, wires, stopSignal, budgetMs, round = 0, broadStrategy, solver = 'local', restartOnImprovement = false, splitCircuit = false }: { gates: Gate[], wires: number, stopSignal?: SharedArrayBuffer, budgetMs: number, round?: number, broadStrategy?: string, restartOnImprovement?: boolean, splitCircuit?: boolean, solver?: 'local' | 'affine' | 'broad' | 'shuffle' }) => {
	try {
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
		const tables = await (portfolio ??= openRainbowPortfolio(config.search.rainbow ? config.database.tables : [], workerData?.sharedTables ?? []))
		if (solver === 'broad') {
			caches.broadStrategyPicker.beginRound(round, broadStrategy)
			resetStrategyStats()
			const stop = stopSignal ? new Int32Array(stopSignal) : undefined
			const result = await broadSearch(tables, gates, wires, caches, budgetMs, () => stop !== undefined && Atomics.load(stop, 0) !== 0, (progress, activity, snapshot) => parentPort!.postMessage({ progress, activity, snapshot }))
			parentPort!.postMessage({ gates: result })
			return
		}
		caches.strategyPicker.beginRound(round)
		let lastSnapshot = gates
		let lastConsideredImprovement = 0
		const stop = stopSignal ? new Int32Array(stopSignal) : undefined
		const result = await optimize(tables, gates, wires, 'worker', true, caches, Math.min(budgetMs, WORKER_ROUND_MS), (count, activity, candidate) => {
			const improves = candidate && (splitCircuit
				? count < lastSnapshot.length || (count === lastSnapshot.length && activity.improvements > lastConsideredImprovement)
				: isBetterCircuit(candidate, lastSnapshot))
			const snapshot = improves ? candidate : undefined
			if (candidate) lastConsideredImprovement = activity.improvements
			if (snapshot) lastSnapshot = snapshot
			parentPort!.postMessage({ progress: count, activity, snapshot })
		}, activity => (restartOnImprovement && lastSnapshot.length < gates.length) || (stop !== undefined && Atomics.load(stop, 0) !== 0) || (workerData?.maximumChecks > 0 && (activity?.checks ?? 0) >= workerData.maximumChecks), (count, improvements) => count < lastSnapshot.length || (count === lastSnapshot.length && improvements > lastConsideredImprovement), true)
		parentPort!.postMessage({ gates: result })
	} catch (error) {
		parentPort!.postMessage({ error: String(error) })
	}
})
