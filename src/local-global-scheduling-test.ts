import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as wait } from 'node:timers/promises'
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
	const reports: string[] = []
	console.log = (...args: unknown[]) => { reports.push(args.map(String).join(' ')) }
	Object.assign(config.workers, { maximum: 4, keepBusy: true, jobsPerWorker: 1, broadSearchIdleSeconds: 600, broadSearchSeconds: 600 })
	config.timing.checkpointSeconds = 0.005
	config.timing.summarySeconds = 0.01
	for (const broadRemoved of [2, 4, 8]) {
		const path = join(directory, 'puzzle-' + broadRemoved)
		reports.length = 0
		const expectCheckpointAndStatus = async (removed: number, delta: number) => {
			const count = circuit.gates.length - removed
			const expectedStatus = `Gates: ${count} - ${delta} (`
			const deadline = performance.now() + 5000
			while (performance.now() < deadline) {
				const latest = JSON.parse(await readFile(path + '-latest.json', 'utf8'))
				if (latest.gates.length === count && reports.some(line => line.includes(expectedStatus))) return
				await wait(5)
			}
			assert.fail(`Expected checkpoint and status ${expectedStatus}`)
		}
		let broadJobs = 0, localImproved = false
		let releaseBroad!: () => void
		const localReported = new Promise<void>(resolve => { releaseBroad = resolve })
		WorkerPool.prototype.run = async function(gates, wires, progress, signal, budget, restart, solver, jobRound, broadStrategy) {
			const stop = new Int32Array(signal!)
			assert.equal(restart, false)
			if (jobRound === 2) {
				if (solver === 'broad') {
					assert.equal(broadStrategy, broadRemoved > 4 ? 'rainbow' : 'variables')
					throw done
				}
				return gates
			}
			if (solver === 'broad') {
				assert.equal(broadStrategy, 'rainbow', 'broad refills keep the round strategy')
				if (++broadJobs === 1) {
					const candidate = gates.slice(broadRemoved)
					progress?.(candidate.length, {
						workerId: 1, activeStrategy: 'sat-sweeping', scope: 'broad', stage: 'searching',
						passes: 1, subsets: 1, checks: 1, improvements: 1,
						strategies: [{ strategy: 'sat-sweeping broad', settings: '', attempts: 1, elapsedMs: 100, rewrites: 1, gatesRemoved: broadRemoved }],
					}, candidate)
					assert.equal(Atomics.load(stop, 0), 0, 'global improvement leaves local peers running')
					await localReported
					return gates // The best progress snapshot must survive a weaker final result.
				}
				assert.equal(gates.length, circuit.gates.length - broadRemoved, 'global refills use only the global candidate')
				if (broadRemoved < 4) await expectCheckpointAndStatus(4, 4 - broadRemoved)
				assert.equal(Atomics.load(stop, 0), 0, 'neither lane cancels the other before round end')
				Atomics.store(stop, 0, 1)
				return gates
			}
			if (!localImproved) {
				assert.equal(broadJobs, 1, 'global work starts alongside local jobs regardless of idle settings')
				localImproved = true
				await expectCheckpointAndStatus(broadRemoved, broadRemoved)
				progress?.(gates.length - 4, {
					workerId: 2, activeStrategy: 'rainbow', stage: 'searching',
					passes: 1, subsets: 1, checks: 1, improvements: 1,
					strategies: [{ strategy: 'rainbow', settings: '', attempts: 1, elapsedMs: 50, rewrites: 1, gatesRemoved: 4 }],
				}, gates.slice(4))
				assert.equal(Atomics.load(stop, 0), 0, 'local improvement leaves the other work running')
				releaseBroad()
			}
			await new Promise(resolve => setTimeout(resolve, 2))
			return gates
		}
		await assert.rejects(splitTaskAndRun(path, 'unused', { originalCircuit: circuit, inputCircuit: circuit }), error => error === done)
		const latest = JSON.parse(await readFile(path + '-latest.json', 'utf8'))
		assert.equal(latest.gates.length, circuit.gates.length - Math.max(broadRemoved, 4))
		assert.ok(reports.some(line => line.includes(`Round winner: ${broadRemoved > 4 ? 'global' : 'local'} | Local: 4 gates removed | Global: ${broadRemoved} gates removed`)))
		assert.ok(reports.some(line => line.endsWith('Local strategies: rainbow:1')))
		assert.ok(reports.some(line => line.endsWith('Global strategies: SAT sweep:1')))
		assert.ok(reports.some(line => line.endsWith('Local tried (worker time): rainbow 1x/0.05s')))
		assert.ok(reports.some(line => line.endsWith('Global tried (worker time): SAT sweep broad 1x/0.10s')))
	}
} finally {
	Object.assign(config, saved)
	WorkerPool.prototype.run = run
	console.log = log
	await rm(directory, { recursive: true, force: true })
}
console.log('Parallel lanes report and checkpoint the stronger result during the round and at round end')
