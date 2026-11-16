import { logTimed } from './utils.js'

export const verboseLogging = () => process.env.OPTIMIZER_VERBOSE === '1'
export function logVerbose(...args: unknown[]) {
	if (verboseLogging()) logTimed(...args)
}

export function formatProgress(initialGates: number, candidateGates: number, completed: number, workers: number, elapsedMs: number) {
	const removed = initialGates - candidateGates
	const elapsed = Math.max(0, elapsedMs) / 1000
	const rate = elapsed > 0 ? Math.round(removed * 60 / elapsed) : 0
	return `Progress: ${completed}/${workers} chunks completed; ${candidateGates} candidate gates (${removed} removed, ${rate}/min); elapsed ${Math.floor(elapsed / 60)}m ${Math.floor(elapsed % 60)}s. Latest checkpoint updates when the round completes.`
}
