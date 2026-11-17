import type { StrategyStat } from './strategy-stats.js'
import { config } from './config.js'
import { logTimed } from './utils.js'
import type { RainbowTableStats } from './rainbow-portfolio.js'

export const verboseLogging = () => process.env.OPTIMIZER_VERBOSE === undefined ? config.logging.verbose : process.env.OPTIMIZER_VERBOSE === '1'
export function logVerbose(...args: unknown[]) {
	if (verboseLogging()) logTimed(...args)
}

export function formatProgress(initialGates: number, candidateGates: number, completed: number, workers: number, elapsedMs: number) {
	const removed = initialGates - candidateGates
	const elapsed = Math.max(0, elapsedMs) / 1000
	const rate = elapsed > 0 ? Math.round(removed * 60 / elapsed) : 0
	return `Progress: ${completed}/${workers} chunks completed; ${candidateGates} candidate gates (${removed} removed, ${rate}/min); elapsed ${Math.floor(elapsed / 60)}m ${Math.floor(elapsed % 60)}s. Checkpoints update every ${config.timing.summarySeconds}s when candidate gates decrease, after verification.`
}

export type WorkerActivity = {
	passes: number
	subsets: number
	checks: number
	improvements: number
	stage: 'searching' | 'shuffling' | 'verifying'
	strategies?: StrategyStat[]
	rainbowTables?: RainbowTableStats[]
	resources?: { databaseMs: number, elapsedMs: number, heapUsedBytes: number }
}
export type WorkerStatus = { activity?: WorkerActivity, updatedAtMs: number, done: boolean, started?: boolean }

export function formatWorkerActivity(statuses: WorkerStatus[], elapsedMs: number, budgetMs: number) {
	const totals = { passes: 0, subsets: 0, checks: 0, improvements: 0 }
	const stages = { searching: 0, shuffling: 0, verifying: 0, waiting: 0, completed: 0 }
	let oldest = 0
	for (const status of statuses) {
		if (status.activity) for (const key of ['passes', 'subsets', 'checks', 'improvements'] as const) totals[key] += status.activity[key]
		if (status.done) stages.completed++
		else {
			stages[status.activity?.stage ?? 'waiting']++
			if (status.started !== false) oldest = Math.max(oldest, elapsedMs - status.updatedAtMs)
		}
	}
	const budget = Math.min(100, Math.floor(Math.max(0, elapsedMs) / budgetMs * 100))
	return `Work: ${totals.passes} passes, ${totals.subsets} subsets visited, ${totals.checks} optimization checks, ${totals.improvements} improving rewrites; workers: ${stages.searching} searching, ${stages.shuffling} shuffling, ${stages.verifying} verifying, ${stages.waiting} awaiting report, ${stages.completed} completed; round time budget ${budget}% elapsed (not search completion); oldest active report ${Math.max(0, Math.floor(oldest / 1000))}s ago.${formatRainbowActivity(statuses)}`
}

export const shouldFinishReducedRound = (elapsedMs: number, initialCount: number, currentCount: number) => elapsedMs >= config.timing.improvedRoundMinutes * 60_000 && currentCount < initialCount

const duration = (ms: number) => `${Math.floor(Math.max(0, ms) / 60_000)}m ${Math.floor(Math.max(0, ms) / 1000) % 60}s`
export type SolverStatus = {
	original: number
	roundStart: number
	candidate: number
	saved?: number
	statuses: WorkerStatus[]
	elapsedMs: number
}
export function formatStatus(status: SolverStatus) {
	const { original, roundStart, candidate, saved, statuses, elapsedMs } = status
	const reduction = original > 0 ? Math.max(0, (original - candidate) / original * 100) : 0
	const finished = statuses.filter(worker => worker.done).length
	const targetMs = (candidate < roundStart ? config.timing.improvedRoundMinutes : config.timing.roundMinutes) * 60_000
	const progress = Math.min(100, Math.floor(Math.max(0, elapsedMs) / targetMs * 100))
	const round = finished === statuses.length
		? `Round finished in ${duration(elapsedMs)}`
		: elapsedMs >= targetMs ? 'Finishing round (time target reached; waiting for optimization steps)'
		: `Round time: ${duration(elapsedMs)} / ${duration(targetMs)} target (${progress}% elapsed)`
	const save = saved === undefined ? 'No checkpoint saved this run yet' : saved === candidate ? 'Checkpoint up to date' : `Checkpoint: ${saved} gates; new reductions pending save`
	const active = statuses.filter(worker => !worker.done && worker.started !== false).length
	const queued = statuses.filter(worker => !worker.done && worker.started === false).length
	const late = statuses.filter(worker => !worker.done && worker.started !== false && elapsedMs - worker.updatedAtMs > Math.max(config.timing.summarySeconds * 2000, config.timing.workerReportSeconds * 3000)).length
	return `Gates: ${candidate} (${reduction.toFixed(2)}% fewer than original; ${Math.max(0, roundStart - candidate)} removed this round) | ${save} | ${finished === statuses.length ? 'All workers finished' : `${active} worker${active === 1 ? '' : 's'} active${queued ? `; ${queued} job${queued === 1 ? '' : 's'} queued` : ''}`} | ${round}${late ? ` | Warning: ${late} worker update${late === 1 ? '' : 's'} delayed` : ''}`
}

/** Per-job snapshots are summed once, including completed jobs in this round. */
export function formatRainbowActivity(statuses: WorkerStatus[]) {
	const totals = new Map<string, RainbowTableStats>()
	for (const status of statuses) for (const stat of status.activity?.rainbowTables ?? []) {
		const id = `${stat.wires}/${stat.gates}`
		const total = totals.get(id) ?? { ...stat, windows: 0, matches: 0, rewrites: 0, gatesRemoved: 0, lookupMs: 0 }
		for (const key of ['windows', 'matches', 'rewrites', 'gatesRemoved', 'lookupMs'] as const) total[key] += stat[key]
		totals.set(id, total)
	}
	return totals.size ? ' Tables: ' + [...totals.entries()].map(([id, stat]) => `${id}: ${stat.gatesRemoved} gates removed, ${stat.rewrites} rewrites, ${stat.windows ? (stat.matches / stat.windows * 100).toFixed(1) : '0.0'}% improving matches, ${(stat.lookupMs / 1000).toFixed(2)} lookup worker-seconds`).join('; ') + '.' : ''
}

/** Latest per-job snapshots prevent repeated progress reports counting twice. */
export function formatStrategyActivity(statuses: WorkerStatus[]) {
	const totals = new Map<string, StrategyStat>()
	for (const status of statuses) for (const stat of status.activity?.strategies ?? []) {
		const key = `${stat.strategy}:${stat.settings}`
		const total = totals.get(key) ?? { ...stat, attempts: 0, rewrites: 0, gatesRemoved: 0, elapsedMs: 0 }
		for (const field of ['attempts', 'rewrites', 'gatesRemoved', 'elapsedMs'] as const) total[field] += stat[field]
		totals.set(key, total)
	}
	return 'Strategies this round: ' + ([...totals.values()].sort((a, b) => b.gatesRemoved - a.gatesRemoved).map(stat => `${stat.strategy} ${stat.settings}: ${stat.gatesRemoved} gates removed, ${stat.rewrites}/${stat.attempts} improving attempts, ${(stat.elapsedMs / 1000).toFixed(3)} worker-seconds`).join('; ') || 'awaiting worker reports') + '.'
}
