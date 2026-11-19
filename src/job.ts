import { config, configPath } from './config.js'
import { existsSync } from 'fs'
import { verboseLogging } from './logging.js'
import { basename, dirname, resolve } from 'path'
import { CircuitData } from './types.js'
import { logTimed, readJsonFile } from './utils.js'
import { outputPaths } from './storage.js'
import { configuredWorkerCount } from './threads.js'
import { databaseFilename } from './rainbowtable.js'

export const WORKER_ROUND_MS = config.timing.roundMinutes * 60_000
export type JobCircuits = { originalCircuit: CircuitData, inputCircuit: CircuitData }

export function loadJob(working: string, original = working, startOver = false): JobCircuits {
	const originalCircuit = readJsonFile(`${original}.json`) as CircuitData | null
	if (!originalCircuit) throw new Error(`Cannot load original circuit: ${original}.json`)
	const latest = outputPaths(working).latest
	const inputPath = !startOver && existsSync(latest) ? latest : !startOver && working !== original && existsSync(`${working}.json`) ? `${working}.json` : undefined
	const inputCircuit = inputPath ? readJsonFile(inputPath) as CircuitData | null : originalCircuit
	if (!inputCircuit) throw new Error(`Cannot load working circuit: ${working}.json`)
	for (const circuit of [originalCircuit, inputCircuit]) {
		if (circuit.wire_count > config.validation.maximumWires) throw new Error('Circuit exceeds validation.maximumWires in solver settings')
	}
	return { originalCircuit, inputCircuit }
}

export function describeJob(working: string, original: string, circuits: JobCircuits) {
	const paths = outputPaths(working)
	const { originalCircuit, inputCircuit } = circuits
	const resuming = inputCircuit !== originalCircuit
	return [
		`Task: optimize circuit ${basename(working)}`,
		`Settings file: ${configPath}`,
		...Object.entries(config).map(([section, settings]) => `Settings ${section}: ${JSON.stringify(settings)}`),
		`Mode: ${resuming ? 'resume saved circuit' : 'start from original circuit'}`,
		`Original: ${resolve(original + '.json')} (${originalCircuit.gates.length} gates, ${originalCircuit.wire_count} wires)`,
		`Input: ${resolve(resuming ? (existsSync(paths.latest) ? paths.latest : working + '.json') : original + '.json')} (${inputCircuit.gates.length} gates, ${inputCircuit.wire_count} wires)`,
		`Requested working file: ${resolve(working + '.json')}`,
		`Latest verified circuit: ${resolve(paths.latest)}`,
		`Progress checkpoints: ${resolve(dirname(paths.progress(inputCircuit.gates.length)))}`,
		`Worker snapshots: ${resolve(dirname(paths.worker(0)))}`,
		`Worker limit: ${configuredWorkerCount()} (${process.env.OPTIMIZER_WORKERS === undefined ? 'automatic CPU-based limit' : 'OPTIMIZER_WORKERS override'}); ${config.workers.keepBusy ? 'continuously refill configured worker slots' : 'actual count depends on circuit size and adaptive concurrency'}`,
		`Round budget: ${WORKER_ROUND_MS / 60_000} minutes; worker job budget: ${config.workers.jobSeconds} seconds; ${config.workers.keepBusy ? 'jobs refill until the round ends' : `up to ${config.workers.jobsPerWorker} jobs per worker`} (checked between optimization steps)`,
		...config.database.tables.map(table => `Rainbow table: ${resolve(databaseFilename(table.wires, table.gates))} (${table.wires} wires, up to ${table.gates} gates)`),
		`Logging: ${verboseLogging() ? 'verbose' : `summaries every ${config.timing.summarySeconds} seconds (OPTIMIZER_VERBOSE=1 enables details)`}`,
		`Optimization: probabilistic=${config.search.probabilistic}; subset sizes ${config.search.subsetMinimum}-${config.search.subsetMaximum}; slice sizes ${config.search.sliceMinimum}-${config.search.sliceMaximum}`,
		`Validation: ${config.validation.checkpointInputs} random inputs at startup/checkpoints; probabilistic replacements use ${config.validation.probabilisticInputs} inputs`,
		`Checkpoints: every ${config.timing.summarySeconds} seconds when gates decrease; rounds finish after ${config.timing.improvedRoundMinutes} minutes with reductions, otherwise use the ${config.timing.roundMinutes}-minute budget. Stop requests are checked between steps. Ctrl+C stops the job.`,
	].join('\n')
}

export function logJob(working: string, original: string, circuits: JobCircuits) {
	for (const line of describeJob(working, original, circuits).split('\n')) {
		if (verboseLogging() || /^(Mode|Original|Input|Latest verified circuit|Logging):/.test(line)) logTimed(line)
	}
}
