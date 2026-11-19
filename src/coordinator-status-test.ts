import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { config } from './config.js'
import { WorkerPool } from './threads.js'
import { splitTaskAndRun, shuffleRowsWithDependentGateSwap } from './processing.js'
import { evalCircuit, generateCombinations } from './utils.js'
import { Gate } from './types.js'
const originalRun = WorkerPool.prototype.run
const saved = structuredClone(config)
const log = console.log, verbose = process.env.OPTIMIZER_VERBOSE
const directory = await mkdtemp(join(tmpdir(), 'coordinator-status-'))
const circuit = { wire_count: 2, gate_count: 5001, gates: Array.from({ length: 5001 }, () => [0, 0, 0, 15] as [number, number, number, number]) }
const done = new Error('test complete')
try {
	config.files.dataDirectory = directory
	config.database.sharedTables = false
	config.workers.maximum = 2
	config.workers.keepBusy = false // Exercise the optional legacy between-round shuffle.
	config.workers.adaptiveConcurrency = false
	config.workers.broadSearchSeconds = 60
	config.workers.broadSearchIdleSeconds = 0 // Isolate global-win reporting without the idle delay.
	config.timing.summarySeconds = 0.02
	config.logging.verbose = false
	process.env.OPTIMIZER_VERBOSE = '0'
	let broadCalls = 0, shuffleCalls = 0
	const reports: string[] = []
	WorkerPool.prototype.run = function(gates, _wires, progress, _stop, _budget, _restart, solver) {
		if (solver === 'shuffle') { shuffleCalls++; return Promise.reject(new Error('Unexpected shuffle after improvement')) }
		if (solver === 'broad') {
			if (++broadCalls === 2) {
				assert.equal(gates.length, 3001)
				return Promise.reject(done)
			}
			progress?.(gates.length, {
				scope: 'broad', workerId: 1, activeStrategy: 'sat-sweeping',
				passes: 1, checks: 1, subsets: 1, improvements: 0, stage: 'searching',
				strategies: [{ strategy: 'sat-sweeping broad', settings: '', attempts: 1, elapsedMs: 500, rewrites: 0, gatesRemoved: 0 }],
			})
			return new Promise(resolve => setTimeout(() => resolve(gates.slice(0, 3001)), 65)) // Same odd NOT parity.
		}
		return Promise.resolve(gates)
	}
	console.log = (...args: unknown[]) => { reports.push(args.map(String).join(' ')) }
	await assert.rejects(splitTaskAndRun(join(directory, 'early'), 'unused', { originalCircuit: circuit, inputCircuit: circuit }), error => error === done)
	assert.equal(shuffleCalls, 0, 'large circuits restart immediately after an improvement instead of running 2000 shuffle passes')

	const counts = reports.filter(line => line.includes('Global strategies:'))
	const timings = reports.filter(line => line.includes('Global tried (worker time):'))
	assert.equal(counts.length, 1)
	assert.match(counts[0], /SAT sweep:1/)
	assert.equal(timings.length, 0)
	const periodic = reports.findIndex(line => line.includes('Circuit: 5001G 0P -0G -0P'))
	assert.ok(periodic >= 0 && periodic < reports.indexOf(counts[0]), 'periodic status precedes the round-end strategy totals')

	let shuffleFinished = false, phaseReports = 0
	let finishShuffle: (() => void) | undefined
	console.log = (...args: unknown[]) => {
		if (args.map(String).join(' ').includes('shuffling next round')) {
			phaseReports++
			if (phaseReports === 3) finishShuffle?.()
		}
	}
	WorkerPool.prototype.run = function(gates, _wires, _progress, _stop, _budget, _restart, solver) {
		if (shuffleFinished) return Promise.reject(done)
		if (solver !== 'shuffle') return Promise.resolve(gates)
		return new Promise((resolve, reject) => {
			const watchdog = setTimeout(() => reject(new Error('No status updates during shuffle')), 5000)
			finishShuffle = () => { clearTimeout(watchdog); shuffleFinished = true; resolve(gates) }
		})
	}
	await assert.rejects(splitTaskAndRun(join(directory, 'phase'), 'unused', { originalCircuit: circuit, inputCircuit: circuit }), error => error === done)
	assert.equal(phaseReports, 3, 'run-wide heartbeat continues while between-round shuffling is awaited')
} finally {
	WorkerPool.prototype.run = originalRun
	console.log = log
	Object.assign(config, saved)
	if (verbose === undefined) delete process.env.OPTIMIZER_VERBOSE; else process.env.OPTIMIZER_VERBOSE = verbose
	await rm(directory, { recursive: true, force: true })
}

// Real CPU work runs off the coordinator thread and returns an equivalent partial shuffle.
const input: Gate[] = Array.from({ length: 10000 }, (_, i) => ({ a: i % 4, b: 0, target: (i + 1) % 4, gate_i: 3 }))
const canceled = structuredClone(input)
shuffleRowsWithDependentGateSwap(canceled, 2000, () => true)
assert.deepEqual(canceled, input)
const pool = new WorkerPool(1)
let ticks = 0
const heartbeat = setInterval(() => ticks++, 1)
try {
	const result = await pool.run(input, 4, undefined, undefined, 40, false, 'shuffle')
	assert.ok(ticks > 0, 'coordinator event loop remains responsive during CPU shuffling')
	assert.equal(result.length, input.length)
	for (const bits of generateCombinations(4)) assert.deepEqual(evalCircuit(result, bits), evalCircuit(input, bits))
} finally { clearInterval(heartbeat); await pool.close() }
console.log('Coordinator status: persistent shuffle heartbeat, immediate improved restarts, off-thread shuffling and exact equivalence passed')
