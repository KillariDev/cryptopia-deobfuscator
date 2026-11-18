import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { config } from './config.js'
import { WorkerPool } from './threads.js'
import { splitTaskAndRun } from './processing.js'

const fixtureSource = `
import {parentPort} from 'node:worker_threads';
parentPort.on('message', async ({gates,solver,stopSignal,sharedTemplates}) => {
 if(sharedTemplates !== undefined) return;
 const signal=new Int32Array(stopSignal);
 parentPort.postMessage({progress:gates.length,activity:{scope:solver==='broad'?'broad':undefined,passes:0,subsets:0,checks:0,improvements:0,stage:'searching'}});
 const end=performance.now()+(solver==='broad'?120:8);
 while(performance.now()<end && !Atomics.load(signal,0)) await new Promise(resolve=>setTimeout(resolve,2));
 parentPort.postMessage({gates});
});`
const fixture = new URL('data:text/javascript,' + encodeURIComponent(fixtureSource))
const originalRun = WorkerPool.prototype.run, saved = structuredClone(config), log = console.log
const directory = await mkdtemp(join(tmpdir(), 'worker-utilization-'))
const done = new Error('first round verified')
let watchdog: ReturnType<typeof setTimeout> | undefined
try {
	config.files.dataDirectory = directory
	config.database.sharedTables = false
	Object.assign(config.workers, { maximum: 4, keepBusy: true, adaptiveConcurrency: true, initialConcurrency: 1, jobsPerWorker: 1, broadSearchSeconds: 0.04 })
	Object.assign(config.timing, { roundMinutes: 0.01, improvedRoundMinutes: 0.005, summarySeconds: 0.025 })
	config.logging.verbose = false
	console.log = () => {}
	let firstSignal: SharedArrayBuffer | undefined
	let peak = 0, localFinished = 0, localFinishedDuringBroad = 0, broadStarted = 0, broadActive = 0
	const active = new Set<number>()
	WorkerPool.prototype.run = function(gates, wires, onProgress, signal, budget, restart, solver) {
		if (solver === 'shuffle') return Promise.reject(new Error('keepBusy must not pause all searches for a serial shuffle'))
		if (!firstSignal) { firstSignal = signal; watchdog = setTimeout(() => Atomics.store(new Int32Array(firstSignal!), 0, 1), 5000) }
		if (signal !== firstSignal) return Promise.reject(done)
		;(this as unknown as { workerUrl: URL }).workerUrl = fixture
		let workerId: number | undefined
		return originalRun.call(this, gates, wires, (count, activity, snapshot) => {
			if (workerId === undefined) {
				workerId = activity!.workerId!; active.add(workerId); peak = Math.max(peak, active.size)
				if (solver === 'broad') { broadStarted++; broadActive++ }
			}
			onProgress?.(count, activity, snapshot)
		}, signal, budget, restart, solver).then(result => {
			if (workerId !== undefined) {
				active.delete(workerId)
				if (solver === 'broad') broadActive--
				else { localFinished++; if (broadActive) localFinishedDuringBroad++ }
			}
			if (localFinishedDuringBroad >= 12 && broadStarted >= 2) Atomics.store(new Int32Array(firstSignal!), 0, 1)
			return result
		})
	}
	const circuit = { wire_count: 2, gate_count: 5001, gates: Array.from({ length: 5001 }, () => [0, 0, 0, 15] as [number, number, number, number]) }
	await assert.rejects(splitTaskAndRun(join(directory, 'puzzle'), 'unused', { originalCircuit: circuit, inputCircuit: circuit }), error => error === done)
	assert.equal(peak, 4, 'use the configured maximum despite the old initial concurrency of one')
	assert.ok(localFinished > 4, 'replenish jobs after the first batch')
	assert.ok(localFinishedDuringBroad > 4, 'local searches continue while the long broad search is active')
	assert.ok(broadStarted >= 2, 'broad work recurs during a continuous round and bypasses queued local work')
	const latest = JSON.parse(await readFile(join(directory, 'puzzle-latest.json'), 'utf8'))
	assert.equal(latest.gates.length, circuit.gates.length, 'refilled jobs never duplicate chunk contributions')
	clearTimeout(watchdog)

	// When chunks become empty, reuse those lanes for independent alternatives
	// of the remaining chunk, and keep its best result only once in assembly.
	const shrinkFixture = new URL('data:text/javascript,' + encodeURIComponent(fixtureSource.replace('parentPort.postMessage({gates});', 'parentPort.postMessage({gates:gates.length%2?[gates[0]]:[]});')))
	config.workers.broadSearchSeconds = 0
	config.workers.wholeCircuitMaximumGates = 0
	firstSignal = undefined
	let retriesFromBest = 0
	WorkerPool.prototype.run = function(gates, wires, onProgress, signal, budget, restart, solver) {
		if (!firstSignal) { firstSignal = signal; watchdog = setTimeout(() => Atomics.store(new Int32Array(firstSignal!), 0, 1), 5000) }
		if (signal !== firstSignal) return Promise.reject(done)
		;(this as unknown as { workerUrl: URL }).workerUrl = shrinkFixture
		if (gates.length === 1) retriesFromBest++
		return originalRun.call(this, gates, wires, onProgress, signal, budget, restart, solver)
	}
	await assert.rejects(splitTaskAndRun(join(directory, 'shrinking'), 'unused', { originalCircuit: circuit, inputCircuit: circuit }), error => error === done)
	assert.ok(retriesFromBest > 4, 'empty lanes retry the current remaining best rather than their original chunks')
	assert.equal(JSON.parse(await readFile(join(directory, 'shrinking-latest.json'), 'utf8')).gates.length, 1, 'alternative retries of one chunk are never concatenated')
	clearTimeout(watchdog)

	// Equal-length reductions in wire/read cost must survive job refills too.
	const simplifyFixture = new URL('data:text/javascript,' + encodeURIComponent(fixtureSource.replace('parentPort.postMessage({gates});', `const n={a:0,b:0,target:1,gate_i:15};parentPort.postMessage({gates:gates.length===3?(gates.every(g=>g.gate_i===15)?[n]:[n,n,n]):gates});`)))
	firstSignal = undefined
	let reusedSimpler = false
	WorkerPool.prototype.run = function(gates, wires, onProgress, signal, budget, restart, solver) {
		if (!firstSignal) { firstSignal = signal; watchdog = setTimeout(() => Atomics.store(new Int32Array(firstSignal!), 0, 1), 5000) }
		if (signal !== firstSignal) return Promise.reject(done)
		;(this as unknown as { workerUrl: URL }).workerUrl = simplifyFixture
		if (gates.length === 3 && gates.every(gate => gate.gate_i === 15)) reusedSimpler = true
		return originalRun.call(this, gates, wires, onProgress, signal, budget, restart, solver)
	}
	const small = { wire_count: 2, gate_count: 3, gates: [[0, 0, 1, 3], [0, 0, 1, 15], [0, 0, 1, 3]] as [number, number, number, number][] }
	await assert.rejects(splitTaskAndRun(join(directory, 'simpler'), 'unused', { originalCircuit: small, inputCircuit: small }), error => error === done)
	assert.equal(reusedSimpler, true, 'retain equally short candidates with lower wire cost for the next attempt')
	assert.equal(JSON.parse(await readFile(join(directory, 'simpler-latest.json'), 'utf8')).gates.length, 1)
} finally {
	clearTimeout(watchdog)
	WorkerPool.prototype.run = originalRun; console.log = log; Object.assign(config, saved)
	await rm(directory, { recursive: true, force: true })
}
console.log('Continuous worker utilization: configured maximum, local refill during broad search, recurring priority broad jobs, round termination and safe chunk assembly passed')
