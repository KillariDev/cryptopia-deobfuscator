import { existsSync } from 'fs'
import { basename, dirname, resolve } from 'path'
import { CircuitData } from './types.js'
import { logTimed, readJsonFile } from './utils.js'
import { outputPaths } from './storage.js'
import { configuredWorkerCount } from './threads.js'
import { RAINBOW_TABLE_GATES, RAINBOW_TABLE_WIRES } from './rainbowtable.js'

export const WORKER_ROUND_MS = 25 * 60_000
export type JobCircuits = { originalCircuit: CircuitData, inputCircuit: CircuitData }

export function loadJob(working: string, original: string): JobCircuits {
	const originalCircuit = readJsonFile(`${original}.json`) as CircuitData | null
	if (!originalCircuit) throw new Error(`Cannot load original circuit: ${original}.json`)
	const inputCircuit = existsSync(`${working}.json`) ? readJsonFile(`${working}.json`) as CircuitData | null : originalCircuit
	if (!inputCircuit) throw new Error(`Cannot load working circuit: ${working}.json`)
	return { originalCircuit, inputCircuit }
}

export function describeJob(working: string, original: string, circuits: JobCircuits) {
	const paths = outputPaths(working)
	const { originalCircuit, inputCircuit } = circuits
	const resuming = inputCircuit !== originalCircuit
	return [
		`Task: optimize circuit ${basename(working)}`,
		`Mode: ${resuming ? 'resume saved circuit' : 'start from original circuit'}`,
		`Original: ${resolve(original + '.json')} (${originalCircuit.gates.length} gates, ${originalCircuit.wire_count} wires)`,
		`Input: ${resolve((resuming ? working : original) + '.json')} (${inputCircuit.gates.length} gates, ${inputCircuit.wire_count} wires)`,
		`Requested working file: ${resolve(working + '.json')}`,
		`Latest completed circuit: ${resolve(paths.latest)}`,
		`Progress checkpoints: ${resolve(dirname(paths.progress(inputCircuit.gates.length)))}`,
		`Worker snapshots: ${resolve(dirname(paths.worker(0)))}`,
		`Worker limit: ${configuredWorkerCount()} (${process.env.OPTIMIZER_WORKERS === undefined ? 'automatic CPU-based limit' : 'OPTIMIZER_WORKERS override'}); actual count depends on circuit size`,
		`Worker round budget: ${WORKER_ROUND_MS / 60_000} minutes (checked between optimization steps)`,
		`Rainbow table: ${resolve(`canonHashrainbowtable_${RAINBOW_TABLE_WIRES}_${RAINBOW_TABLE_GATES}.db`)} (${RAINBOW_TABLE_WIRES} wires, up to ${RAINBOW_TABLE_GATES} gates)`,
		'Optimization: heavy phase; randomized subset and slice sizes from 2 to 199',
		'Validation: 20 random inputs at startup/checkpoints; probabilistic replacements use 202 inputs',
		'Folders are created automatically. Completed rounds are saved; Ctrl+C stops the job.',
	].join('\n')
}

export function logJob(working: string, original: string, circuits: JobCircuits) {
	for (const line of describeJob(working, original, circuits).split('\n')) logTimed(line)
}
