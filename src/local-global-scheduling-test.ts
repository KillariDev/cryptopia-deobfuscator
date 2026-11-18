import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { config } from './config.js'
import { WorkerPool } from './threads.js'
import { splitTaskAndRun } from './processing.js'

const saved = structuredClone(config), run = WorkerPool.prototype.run, log = console.log
const directory = await mkdtemp(join(tmpdir(), 'local-global-'))
const done = new Error('verified round')
const circuit = { wire_count: 2, gate_count: 5001, gates: Array.from({ length: 5001 }, () => [0, 0, 0, 15] as [number, number, number, number]) }
try {
	config.files.dataDirectory = directory
	config.database.sharedTables = false
	config.logging.verbose = false
	console.log = () => {}
	Object.assign(config.workers, { maximum: 4, keepBusy: true, jobsPerWorker: 1, broadSearchIdleSeconds: 600, broadSearchSeconds: 600 })
	config.timing.checkpointSeconds = 0.005
	for (const broadRemoved of [2, 8]) {
		const path = join(directory, 'puzzle-' + broadRemoved)
		let round = 0, broadJobs = 0, localImproved = false
		let releaseBroad!: () => void
		const localReported = new Promise<void>(resolve => { releaseBroad = resolve })
		WorkerPool.prototype.run = async function(gates, wires, progress, signal, budget, restart, solver) {
			const stop = new Int32Array(signal!)
			assert.equal(restart, false)
			if (solver === 'broad') {
				if (++broadJobs === 1) {
					const candidate = gates.slice(broadRemoved)
					progress?.(candidate.length, undefined, candidate)
					assert.equal(Atomics.load(stop, 0), 0, 'global improvement leaves local peers running')
					await localReported
					return gates // The best progress snapshot must survive a weaker final result.
				}
				assert.equal(gates.length, circuit.gates.length - broadRemoved, 'global refills use only the global candidate')
				await new Promise(resolve => setTimeout(resolve, 25))
				assert.equal(JSON.parse(await readFile(path + '-latest.json', 'utf8')).gates.length, circuit.gates.length)
				assert.equal(Atomics.load(stop, 0), 0, 'neither lane cancels the other before round end')
				Atomics.store(stop, 0, 1)
				return gates
			}
			if (!localImproved) {
				assert.equal(broadJobs, 1, 'global work starts alongside local jobs regardless of idle settings')
				localImproved = true
				progress?.(gates.length - 4, undefined, gates.slice(4))
				assert.equal(Atomics.load(stop, 0), 0, 'local improvement leaves the other work running')
				releaseBroad()
			}
			await new Promise(resolve => setTimeout(resolve, 2))
			return gates
		}
		await assert.rejects(splitTaskAndRun(path, 'unused', { originalCircuit: circuit, inputCircuit: circuit }, phase => {
			if (phase === 'running optimizer searches' && ++round === 2) throw done
		}), error => error === done)
		const latest = JSON.parse(await readFile(path + '-latest.json', 'utf8'))
		assert.equal(latest.gates.length, circuit.gates.length - Math.max(broadRemoved, 4))
	}
} finally {
	Object.assign(config, saved)
	WorkerPool.prototype.run = run
	console.log = log
	await rm(directory, { recursive: true, force: true })
}
console.log('Parallel lanes retain independent candidates and save the stronger result at round end')
