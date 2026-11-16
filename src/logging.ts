import { logTimed } from './utils.js'

export const verboseLogging = () => process.env.OPTIMIZER_VERBOSE === '1'
export function logVerbose(...args: unknown[]) {
	if (verboseLogging()) logTimed(...args)
}

export function formatProgress(initialGates: number, candidateGates: number, completed: number, workers: number, elapsedMs: number) {
	const removed = initialGates - candidateGates
	const elapsed = Math.max(0, elapsedMs) / 1000
	const rate = elapsed > 0 ? Math.round(removed * 60 / elapsed) : 0
	return `Progress: ${completed}/${workers} chunks completed; ${candidateGates} candidate gates (${removed} removed, ${rate}/min); elapsed ${Math.floor(elapsed / 60)}m ${Math.floor(elapsed % 60)}s. Checkpoints update every 30s when candidate gates decrease, after verification.`
}

export type WorkerActivity = {
	passes: number
	subsets: number
	checks: number
	improvements: number
	stage: 'searching' | 'shuffling' | 'verifying'
}
export type WorkerStatus = { activity?: WorkerActivity, updatedAtMs: number, done: boolean }

export function formatWorkerActivity(statuses: WorkerStatus[], elapsedMs: number, budgetMs: number) {
	const totals = { passes: 0, subsets: 0, checks: 0, improvements: 0 }
	const stages = { searching: 0, shuffling: 0, verifying: 0, waiting: 0, completed: 0 }
	let oldest = 0
	for (const status of statuses) {
		if (status.activity) for (const key of ['passes', 'subsets', 'checks', 'improvements'] as const) totals[key] += status.activity[key]
		if (status.done) stages.completed++
		else {
			stages[status.activity?.stage ?? 'waiting']++
			oldest = Math.max(oldest, elapsedMs - status.updatedAtMs)
		}
	}
	const budget = Math.min(100, Math.floor(Math.max(0, elapsedMs) / budgetMs * 100))
	return `Work: ${totals.passes} passes, ${totals.subsets} subsets visited, ${totals.checks} optimization checks, ${totals.improvements} improving rewrites; workers: ${stages.searching} searching, ${stages.shuffling} shuffling, ${stages.verifying} verifying, ${stages.waiting} awaiting report, ${stages.completed} completed; round time budget ${budget}% elapsed (not search completion); oldest active report ${Math.max(0, Math.floor(oldest / 1000))}s ago.`
}

export const shouldFinishReducedRound = (elapsedMs: number, initialCount: number, currentCount: number) => elapsedMs >= 5 * 60_000 && currentCount < initialCount
