import { isBetterCircuit } from './circuit-cost.js'
import { broadSearch } from './broad-search.js'
import { recordStrategy, resetStrategyStats, strategySnapshot } from './strategy-stats.js'
import { config } from './config.js'
import { wholeCircuitAffineSearch } from './strategies.js'
import { parentPort, workerData } from 'worker_threads'
import { createOptimizerCaches, optimize, polynomialShearSearch, shuffleRowsWithDependentGateSwap } from './processing.js'
import { openRainbowPortfolio } from './rainbow-portfolio.js'
import { Gate } from './types.js'
import type { WorkerSolver } from './threads.js'
import { WORKER_ROUND_MS } from './job.js'

let portfolio: ReturnType<typeof openRainbowPortfolio> | undefined
let localCaches: ReturnType<typeof createOptimizerCaches> | undefined
let broadCaches: ReturnType<typeof createOptimizerCaches> | undefined
parentPort!.on('message', async ({ gates, wires, stopSignal, budgetMs, round = 0, localIndex, assignedStrategy, solver = 'local', restartOnImprovement = false, splitCircuit = false, helperShuffleSeed }: { gates: Gate[], wires: number, stopSignal?: SharedArrayBuffer, budgetMs: number, round?: number, localIndex?: number, assignedStrategy?: string, restartOnImprovement?: boolean, splitCircuit?: boolean, helperShuffleSeed?: number, solver?: WorkerSolver }) => {
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
		if (solver === 'shear-probe') {
			resetStrategyStats()
			const stop = stopSignal ? new Int32Array(stopSignal) : undefined
			const result = polynomialShearSearch(gates, performance.now() + budgetMs, () => stop !== undefined && Atomics.load(stop, 0) !== 0)
			parentPort!.postMessage({ gates: result ?? gates })
			return
		}
		// Open once per persistent worker and wait for every connection to be ready.
		const tables = await (portfolio ??= openRainbowPortfolio(config.search.rainbow ? config.database.tables : [], workerData?.sharedTables ?? []))
		if (solver === 'broad') {
			const caches = broadCaches ??= createOptimizerCaches(workerData?.workerIndex ?? 0)
			caches.broadStrategyPicker.beginRound(round, assignedStrategy)
			resetStrategyStats()
			const stop = stopSignal ? new Int32Array(stopSignal) : undefined
			const result = await broadSearch(tables, gates, wires, caches, budgetMs, () => stop !== undefined && Atomics.load(stop, 0) !== 0, (progress, activity, snapshot) => parentPort!.postMessage({ progress, activity, snapshot }))
			parentPort!.postMessage({ gates: result })
			return
		}
		const caches = localCaches ??= createOptimizerCaches(localIndex ?? workerData?.workerIndex ?? 0)
		caches.strategyPicker.beginRound(round, assignedStrategy)
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
		}, () => (restartOnImprovement && lastSnapshot.length < gates.length) || (stop !== undefined && Atomics.load(stop, 0) !== 0), (count, improvements) => count < lastSnapshot.length || (count === lastSnapshot.length && improvements > lastConsideredImprovement), true, workerData?.remainingChecks, assignedStrategy !== undefined, helperShuffleSeed)
		parentPort!.postMessage({ gates: result })
	} catch (error) {
		parentPort!.postMessage({ error: String(error) })
	}
})
