import { existsSync } from 'fs'
import { seededRandom } from './random.js'
import type { CircuitData } from './types.js'

process.once('message', async (message: { input: CircuitData, original: CircuitData, workers: number, seed: number }) => {
	try {
		Math.random = seededRandom(message.seed)
		const { config } = await import('./config.js')
		const { WorkerPool } = await import('./threads.js')
		const { loadSharedTables, sharedTableBytes } = await import('./shared-table.js')
		const { getRainbowTable, databaseFilename, databaseReady, hasCanonicalCoverage, closeRainbowTable } = await import('./rainbowtable.js')
		const { chunkArray, verifyCircuit, calculateAllOutputsArray, generateCombinations } = await import('./utils.js')
		const startup = performance.now()
		for (const spec of config.database.tables) {
			if (!existsSync(databaseFilename(spec.wires, spec.gates))) throw new Error('Benchmark needs existing completed tables; run optimize to build them first')
			const db = getRainbowTable(spec.wires, spec.gates)
			try { await databaseReady(db); if (!await hasCanonicalCoverage(db, spec.wires, spec.gates)) throw new Error('Benchmark requires completed canonical rainbow tables') }
			finally { await closeRainbowTable(db) }
		}
		const shared = await loadSharedTables(), startupMs = performance.now() - startup
		const gates = message.input.gates.map(([a, b, target, gate_i]) => ({ a, b, target, gate_i }))
		const original = message.original.gates.map(([a, b, target, gate_i]) => ({ a, b, target, gate_i }))
		verifyCircuit(original, gates, message.input.wire_count, config.validation.checkpointInputs)
		const pool = new WorkerPool(message.workers, new URL('./benchmark-worker.js', import.meta.url), shared, message.seed, config.benchmark.maximumChecks)
		const stop = new Int32Array(new SharedArrayBuffer(4)), started = performance.now()
		let peakRssBytes = process.memoryUsage().rss
		const monitor = setInterval(() => { peakRssBytes = Math.max(peakRssBytes, process.memoryUsage().rss) }, 50)
		const timer = setTimeout(() => Atomics.store(stop, 0, 1), config.benchmark.seconds * 1000)
		const chunks = gates.length ? chunkArray(gates, Math.min(gates.length, message.workers * config.workers.jobsPerWorker)) : []
		const activities = chunks.map(() => ({ checks: 0, databaseMs: 0, workerMs: 0 }))
		let result = gates
		try {
			result = (await Promise.all(chunks.map((chunk, i) => pool.run(chunk, message.input.wire_count, (_, activity) => {
				if (activity) activities[i] = { checks: activity.checks, databaseMs: activity.resources?.databaseMs ?? 0, workerMs: activity.resources?.elapsedMs ?? 0 }
			}, stop.buffer as SharedArrayBuffer, config.benchmark.seconds * 1000)))).flat()
		} finally {
			clearTimeout(timer); clearInterval(monitor)
			peakRssBytes = Math.max(peakRssBytes, process.memoryUsage().rss)
			await pool.close()
		}
		const wallMs = performance.now() - started
		verifyCircuit(original, result, message.input.wire_count, config.validation.checkpointInputs)
		let validation = 'random checkpoint inputs'
		if (message.input.wire_count <= 8) {
			const inputs = generateCombinations(message.input.wire_count)
			const before = calculateAllOutputsArray(original, inputs), after = calculateAllOutputsArray(result, inputs)
			if (before.some((bit, i) => bit !== after[i])) throw new Error('Benchmark result failed exhaustive validation')
			validation = 'exhaustive'
		}
		process.send?.({ result: { workers: message.workers, seed: message.seed, startupMs, wallMs, budgetSeconds: config.benchmark.seconds, initialGates: gates.length, finalGates: result.length, removed: gates.length - result.length, gatesPerSecond: (gates.length - result.length) * 1000 / Math.max(1, wallMs), peakRssBytes, sharedBytes: shared.reduce((sum, table) => sum + sharedTableBytes(table), 0), checks: activities.reduce((sum, activity) => sum + activity.checks, 0), databaseMs: activities.reduce((sum, activity) => sum + activity.databaseMs, 0), workerMs: activities.reduce((sum, activity) => sum + activity.workerMs, 0), validation } })
		process.disconnect()
	} catch (error) {
		process.send?.({ error: String(error) }); process.exitCode = 1; process.disconnect()
	}
})
