import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as wait } from 'node:timers/promises'
import { config } from './config.js'
import { WorkerPool } from './threads.js'
import { splitTaskAndRun } from './processing.js'
import { outputPaths } from './storage.js'
import type { CircuitData } from './types.js'

const saved = structuredClone(config), run = WorkerPool.prototype.run, log = console.log
const directory = await mkdtemp(join(tmpdir(), 'local-global-'))
const done = new Error('verified round')
const circuit = { wire_count: 2, gate_count: 5001, gates: Array.from({ length: 5001 }, () => [0, 0, 0, 15] as [number, number, number, number]) }
try {
	config.search.localStrategyOrder = []
	config.search.broadStrategyOrder = []
	config.files.dataDirectory = directory
	config.database.sharedTables = false
	config.logging.verbose = false
	const reports: string[] = []
	console.log = (...args: unknown[]) => { reports.push(args.map(String).join(' ')) }
	Object.assign(config.workers, { maximum: 4, keepBusy: true, jobsPerWorker: 1, wholeCircuitMaximumGates: 6000, broadSearchIdleSeconds: 600, broadSearchSeconds: 600 })
	config.timing.checkpointSeconds = 0.005
	config.timing.summarySeconds = 0.01
	for (const [broadRemoved, wholeCircuit] of [[0, true], [2, true], [4, true], [8, true], [2, false]] as const) {
		config.workers.wholeCircuitMaximumGates = wholeCircuit ? 6000 : 0
		const winner = !wholeCircuit ? 'combined' : broadRemoved > 4 ? 'global' : 'local'
		const path = join(directory, `puzzle-${broadRemoved}-${wholeCircuit}`)
		reports.length = 0
		const expectCheckpointAndStatus = async (removed: number, delta: number) => {
			const count = circuit.gates.length - removed
			const expectedStatus = `Circuit: ${count}G 0P -${delta}G -0P (`
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
					assert.equal(broadStrategy, broadRemoved === 0 ? 'polynomial-shear-interpolation' : 'sat-sweeping')
					throw done
				}
				return gates
			}
			if (solver === 'broad') {
				assert.equal(broadStrategy, 'sat-sweeping', 'broad refills keep the round strategy')
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
					workerId: 2, activeStrategy: 'truth-table-lookup', stage: 'searching',
					passes: 1, subsets: 1, checks: 1, improvements: 1,
					strategies: [{ strategy: 'truth-table-lookup', settings: '', attempts: 1, elapsedMs: 50, rewrites: 1, gatesRemoved: 4 }],
				}, gates.slice(4))
				assert.equal(Atomics.load(stop, 0), 0, 'local improvement leaves the other work running')
				releaseBroad()
			}
			await new Promise(resolve => setTimeout(resolve, 2))
			return gates
		}
		await assert.rejects(splitTaskAndRun(path, 'unused', { originalCircuit: circuit, inputCircuit: circuit }), error => error === done)
		await assert.rejects(readFile(outputPaths(path).worker(0)), { code: 'ENOENT' })
		const latest = JSON.parse(await readFile(path + '-latest.json', 'utf8'))
		assert.equal(latest.gates.length, circuit.gates.length - (wholeCircuit ? Math.max(broadRemoved, 4) : broadRemoved + 4))
		const resultLine = reports.find(line => line.includes(`Round winner: ${winner} | Local: 4 gates removed | Global: ${broadRemoved} gates removed`))
		assert.match(resultLine ?? '', / \| [1-9]\d* gates\/hour$/)
		assert.ok(reports.every(line => !/\| (Local|Global) worker \d+ started/.test(line)))
		assert.ok(reports.some(line => line.endsWith('Local strategies: truth-table-lookup:1')))
		assert.ok(reports.some(line => line.endsWith('Global strategies: SAT sweep:1')))
		assert.ok(reports.every(line => !line.includes(' tried (worker time):')))
	}

	Object.assign(config.workers, { maximum: 2, keepBusy: false, adaptiveConcurrency: false, minimumChunkGates: 2,
		maximumChunkFraction: 0.5, wholeCircuitMaximumGates: 0, broadSearchSeconds: 0 })
	config.search.balancedWorkers = false
	const ab = { a: 0, b: 0, target: 1, gate_i: 3 }, ac = { ...ab, target: 2 }
	const original = [ab, ab, ac, ac]
	const splitFixture: CircuitData = {
		wire_count: 3, gate_count: original.length, gates: original.map(gate => [gate.a, gate.b, gate.target, gate.gate_i]),
	}
	WorkerPool.prototype.run = async function(gates, _wires, progress, _signal, _budget, _restart, solver, round, _strategy, split) {
		if (round === 2) throw done
		if (solver === 'local') {
			assert.equal(split, true)
			if (gates.some(gate => gate.target === 2)) {
				const candidate = gates.map(gate => gate.target === 2 ? ab : gate)
				progress?.(candidate.length, undefined, candidate)
			}
		}
		return gates
	}
	const path = join(directory, 'global-wire-score')
	await assert.rejects(splitTaskAndRun(path, 'unused', { originalCircuit: splitFixture, inputCircuit: splitFixture }), error => error === done)
	const result: CircuitData = JSON.parse(await readFile(path + '-latest.json', 'utf8'))
	assert.equal(result.gate_count, original.length)
	assert.deepEqual(result.gates, splitFixture.gates)

	Object.assign(config.workers, { keepBusy: true, broadSearchSeconds: 60 })
	Object.assign(config.synthesis, { satSweeping: false, quadraticShear: false, decisionDiagramProduct: false, mixedBasis: false, blockCancellation: true, affine: false, quadratic: false, factored: false })
	config.search.dependencyCuts = false
	let broadDispatches = 0
	WorkerPool.prototype.run = async function(gates, _wires, progress, signal, _budget, _restart, solver, round) {
		if (solver === 'broad') {
			broadDispatches++
			progress?.(gates.length, { scope: 'broad', stage: 'searching', broadExhausted: true, passes: 1, subsets: 1, checks: 1, improvements: 0 })
			return gates
		}
		if (round === 2) throw done
		Atomics.store(new Int32Array(signal!), 0, 1)
		return gates
	}
	await assert.rejects(splitTaskAndRun(join(directory, 'exhausted'), 'unused', { originalCircuit: circuit, inputCircuit: circuit }), error => error === done)
	assert.equal(broadDispatches, 1, 'unchanged rounds do not dispatch an exhausted broad scan again')
	const zeroCircuit: CircuitData = { ...circuit, gate_count: 5000, gates: circuit.gates.slice(1) }
	const zeroPath = join(directory, 'broad-solved')
	config.files.workerSnapshots = true
	let finishLocal!: () => void
	const localStarted = new Promise<void>(resolve => { finishLocal = resolve })
	let localJobs = 0, firstLocalChunkSize = 0
	WorkerPool.prototype.run = async function(gates, _wires, progress, signal, _budget, _restart, solver) {
		const stop = new Int32Array(signal!)
		if (solver === 'broad') {
			await localStarted
			progress?.(0, undefined, [])
			assert.equal(Atomics.load(stop, 0), 1, 'a complete broad result stops local workers immediately')
			return []
		}
		if (localJobs++ === 0) firstLocalChunkSize = gates.length
		finishLocal()
		await wait(5)
		return gates
	}
	await splitTaskAndRun(zeroPath, 'unused', { originalCircuit: zeroCircuit, inputCircuit: zeroCircuit })
	assert.ok(localJobs > 0)
	assert.equal(JSON.parse(await readFile(outputPaths(zeroPath).worker(0), 'utf8')).gate_count, firstLocalChunkSize)
	assert.equal(JSON.parse(await readFile(zeroPath + '-latest.json', 'utf8')).gate_count, 0)

	Object.assign(config.workers, { maximum: 1, keepBusy: false, jobsPerWorker: 1, wholeCircuitMaximumGates: 10 })
	Object.assign(config.search, { rainbow: true, variableElimination: false, strategyAdaptive: false })
	Object.assign(config.synthesis, {
		affine: false, quadratic: true, blockCancellation: true, decisionDiagramProduct: true, forwardSemanticSearch: false,
		equalitySaturation: false, smt: false, meetInMiddle: false,
	})
	const attempts: (string | undefined)[] = []
	WorkerPool.prototype.run = async function(gates, _wires, _progress, _signal, _budget, _restart, solver, round, assigned, split) {
		if (round === 2) throw done
		assert.equal(solver, 'local')
		assert.equal(split, false)
		assert.equal(gates.length, splitFixture.gate_count)
		attempts.push(assigned)
		return gates
	}
	await assert.rejects(splitTaskAndRun(join(directory, 'whole-strategies'), 'unused',
		{ originalCircuit: splitFixture, inputCircuit: splitFixture }), error => error === done)
	assert.deepEqual(attempts, ['anf-synthesis', 'truth-table-lookup', 'block-cancellation', 'decision-diagram-product'])


	config.workers.wholeCircuitMaximumGates = 0
	config.synthesis.quadraticShear = true
	const probePath = join(directory, 'startup-shear')
	let shearProbes = 0
	WorkerPool.prototype.run = async function(gates, _wires, _progress, _signal, budget, _restart, solver, round, _assigned, split) {
		if (solver === 'shear-probe') {
			assert.equal(++shearProbes, 1)
			assert.equal(gates.length, circuit.gate_count)
			assert.ok(budget! > 0 && budget! <= 1000)
			return gates.slice(2)
		}
		if (round === 2) throw done
		if (solver === 'local') {
			assert.equal(shearProbes, 1)
			assert.equal(split, true)
			assert.equal(gates.length, circuit.gate_count - 2)
			const latest: CircuitData = JSON.parse(await readFile(outputPaths(probePath).latest, 'utf8'))
			assert.equal(latest.gate_count, gates.length)
		}
		return gates
	}
	await assert.rejects(splitTaskAndRun(probePath, 'unused',
		{ originalCircuit: circuit, inputCircuit: circuit }), error => error === done)
	assert.equal(shearProbes, 1)

} finally {
	Object.assign(config, saved)
	WorkerPool.prototype.run = run
	console.log = log
	await rm(directory, { recursive: true, force: true })
}
console.log('Parallel lanes report and checkpoint the stronger result during the round and at round end')
