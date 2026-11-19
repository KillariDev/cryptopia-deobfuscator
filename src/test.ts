import type { Database } from 'sqlite3'
import { areCircuitsProbabilisticallyTheSame, combineGates } from './processing.js'
import { Gate } from './types.js'
import { gatesToText, generateNRandomBooleanArray } from './utils.js'

const INPUTS = 202

const runTests = () => {
	const t1 = () => { 
		console.log('t1')
		const gates: Gate[] = [
			{ a: 1, b: 2, target: 0, gate_i: 1 },
			{ a: 1, b: 0, target: 0, gate_i: 3 },
		]
		const mappedGates = combineGates(gates)
		console.log(gatesToText(gates))
		console.log('to')
		console.log(gatesToText(mappedGates.gates))
		if (!areCircuitsProbabilisticallyTheSame([], gates, mappedGates.gates, INPUTS, 64)) throw new Error('mismatch')
	}
	t1()
	const t2 = () => { 
		console.log('t2')
		const gates: Gate[] = [
			{ a: 1, b: 0, target: 0, gate_i: 3 },
			{ a: 0, b: 0, target: 1, gate_i: 3 },
		]
		const mappedGates = combineGates(gates)
		console.log(gatesToText(gates))
		console.log('to')
		console.log(gatesToText(mappedGates.gates))
		if (!areCircuitsProbabilisticallyTheSame([], gates, mappedGates.gates, INPUTS, 64)) throw new Error('mismatch')
	}
	t2()

}

runTests()
// Exhaustive/reference regressions for the optimized hot paths.
import assert from 'node:assert/strict'
import { generationLookupSchema } from './generation-storage.js'
const { calculateAllOutputsArray, evalCircuit, generateCombinations, getVars } = await import('./utils.js')
const { createDependencyGraph } = await import('./lineswapper.js')
const { shuffleRowsWithDependentGateSwap, optimize, createOptimizerCaches } = await import('./processing.js')
const { LimitedMap } = await import('./limitedMap.js')
const { getReplacersByIds, isEmpty, closeRainbowTable } = await import('./rainbowtable.js')
const { RainbowPortfolio } = await import('./rainbow-portfolio.js')
const { default: sqlite3 } = await import('sqlite3')
const { WorkerPool, configuredWorkerCount } = await import('./threads.js')

let seed = 12345
const random = (n: number) => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return (seed >>> 8) % n }
const makeGates = (count: number, wires: number): Gate[] => Array.from({ length: count }, () => ({
	a: random(wires), b: random(wires), target: random(wires), gate_i: random(16),
}))
for (const wires of [1, 2, 4, 5, 6]) {
	const inputs = generateCombinations(wires)
	for (let f = 0; f < 16; f++) for (let a = 0; a < wires; a++) for (let b = 0; b < wires; b++) {
		const gates = [{ a, b, target: a, gate_i: f }]
		assert.deepEqual(calculateAllOutputsArray(gates, inputs), inputs.flatMap(input => evalCircuit(gates, input)))
	}
	const gates = makeGates(100, wires)
	for (const cases of [inputs, inputs.slice(0, 17), [], [...inputs, ...inputs, ...inputs]]) {
		assert.deepEqual(calculateAllOutputsArray(gates, cases), cases.flatMap(input => evalCircuit(gates, input)))
	}
}
// Reference the original forward scan, including gates with aliased controls/targets.
for (let trial = 0; trial < 100; trial++) {
	const gates = makeGates(100, 8)
	const nodes = createDependencyGraph(gates)
	for (let i = 0; i < gates.length; i++) {
		const [target, ...rest] = getVars(gates[i])
		const next = gates.findIndex((gate, j) => j > i && (getVars(gate).includes(target) || rest.includes(gate.target)))
		assert.equal(nodes[i].dependOnFutureLine, next)
	}
}
assert.deepEqual(createDependencyGraph([
	{ a: 0, b: 0, target: 0, gate_i: 15 },
	{ a: 0, b: 0, target: 1, gate_i: 3 },
])[1].dependOnPastLines, [0])
for (let trial = 0; trial < 40; trial++) {
	const gates = makeGates(12, 4)
	const inputs = generateCombinations(4)
	const expected = inputs.flatMap(input => evalCircuit(gates, input))
	shuffleRowsWithDependentGateSwap(gates, 3)
	assert.deepEqual(inputs.flatMap(input => evalCircuit(gates, input)), expected)
}
const db = new sqlite3.Database(':memory:')
const sql = (query: string) => new Promise<void>((resolve, reject) => db.run(query, error => error ? reject(error) : resolve()))
await sql('CREATE TABLE InputOutputReplacers (ioIdentifier BLOB PRIMARY KEY, replacerGates BLOB NOT NULL)')
assert.equal(await isEmpty(db), true)
await sql("INSERT INTO InputOutputReplacers VALUES (X'ff', X'')")
assert.equal(await isEmpty(db), false)
const cache = new LimitedMap<string, Gate[] | null>(100)
assert.deepEqual(await getReplacersByIds(db, cache, ['00', '00', 'ff']), [{ ioIdentifier: 'ff', gates: [] }])
assert.equal(cache.get('00'), null)
const testPortfolio = new RainbowPortfolio([{ db, wires: 4, gates: 5 }])
const optimizerCaches = createOptimizerCaches()
const singleGate = [{ a: 0, b: 0, target: 1, gate_i: 3 }]
for (let round = 0; round < 2; round++) {
	const result = await optimize(testPortfolio, singleGate, 4, 'test', true, optimizerCaches, 1)
	assert.deepEqual(calculateAllOutputsArray(result!, generateCombinations(4)), calculateAllOutputsArray(singleGate, generateCombinations(4)))
}
assert.deepEqual(await optimize(testPortfolio, [], 4, 'test', true, optimizerCaches, 1), [])
await closeRainbowTable(db)
// A cached miss and hit must work even after the database is closed.
assert.deepEqual(await getReplacersByIds(db, cache, ['00', 'ff']), [{ ioIdentifier: 'ff', gates: [] }])
const oldWorkerSetting = process.env.OPTIMIZER_WORKERS
try {
	for (const setting of ['0', '-1', '1.5', 'NaN']) {
		process.env.OPTIMIZER_WORKERS = setting
		assert.throws(configuredWorkerCount, /positive integer/)
	}
	process.env.OPTIMIZER_WORKERS = '2'
	assert.equal(configuredWorkerCount(), 2)
} finally {
	if (oldWorkerSetting === undefined) delete process.env.OPTIMIZER_WORKERS
	else process.env.OPTIMIZER_WORKERS = oldWorkerSetting
}
const fixture = new URL('data:text/javascript,' + encodeURIComponent(`
import { parentPort } from 'node:worker_threads';
let calls = 0;
parentPort.on('message', ({gates}) => {
 if (gates[0]?.gate_i === -1) process.exit(1);
 parentPort.postMessage({progress: gates.length});
 parentPort.postMessage({gates: [...gates, {a: ++calls, b: 0, target: 0, gate_i: 0}]});
});`))
const pool = new WorkerPool(1, fixture)
try {
	const progress: number[] = []
	const results = await Promise.all([pool.run([], 1, count => progress.push(count)), pool.run([], 1), pool.run([], 1)])
	assert.deepEqual(progress, [0])
	assert.deepEqual(results.map(gates => gates[0].a), [1, 2, 3])
	const failures = await Promise.allSettled([
		pool.run([{ a: 0, b: 0, target: 0, gate_i: -1 }], 1),
		pool.run([], 1),
	])
	assert.ok(failures.every(result => result.status === 'rejected'))
	await assert.rejects(pool.run([], 1), /exited/)
} finally { await pool.close() }

// Exercise the real worker entry point without building the production table.
const { mkdtemp, rm } = await import('node:fs/promises')
const { tmpdir } = await import('node:os')
const { join } = await import('node:path')
const originalCwd = process.cwd()
const temporaryDirectory = await mkdtemp(join(tmpdir(), 'deobfuscator-test-'))
const { outputPaths, prepareOutputDirectories, writeCircuit } = await import('./storage.js')
const { loadJob, describeJob } = await import('./job.js')
const { existsSync, readFileSync } = await import('node:fs')
const realPool = new WorkerPool(1)
try {
	process.chdir(temporaryDirectory)
	const paths = outputPaths('original')
	prepareOutputDirectories()
	assert.ok(existsSync('data/worker'))
	assert.ok(existsSync('data/progress'))
	writeCircuit('original.json', 4, singleGate)
	const initialJob = loadJob('original')
	assert.match(describeJob('original', 'original', initialJob), /start from original circuit/)
	for (const filename of [paths.latest, paths.progress(1), paths.worker(0)]) {
		writeCircuit(filename, 4, singleGate)
		assert.equal(JSON.parse(readFileSync(filename, 'utf8')).gates.length, 1)
	}
	assert.equal(loadJob('original', 'original', true).inputCircuit.gates.length, 1)
	writeCircuit(paths.latest, 4, [])
	assert.equal(loadJob('original').inputCircuit.gates.length, 0)
	assert.equal(loadJob('original').originalCircuit.gates.length, 1)
	assert.equal(loadJob('original', 'original', true).inputCircuit.gates.length, 1)
	const summary = describeJob('original', 'original', loadJob('original'))
	assert.match(summary, /resume saved circuit/)
	assert.match(summary, /1 gates, 4 wires/)
	assert.match(summary, /Worker snapshots: disabled/)
	assert.ok(summary.includes(join(temporaryDirectory, 'original-progress')))
	assert.ok(summary.includes(join(temporaryDirectory, 'original-latest.json')))
	assert.notEqual(outputPaths('alpha/puzzle').worker(0), outputPaths('beta/puzzle').worker(0))
	assert.equal(outputPaths('alpha/puzzle').worker(0), outputPaths(join(temporaryDirectory, 'alpha/puzzle')).worker(0))
	const { config: jobConfig } = await import('./config.js')
	const savedPaths = { ...jobConfig.files }
	try {
		Object.assign(jobConfig.files, { latestName: 'resume.json', progressDirectory: 'snapshots' })
		const custom = outputPaths('original')
		assert.equal(custom.latest, 'original-resume.json')
		assert.ok(custom.progress(1).startsWith(join(savedPaths.dataDirectory, 'snapshots') + '/'))
		assert.notEqual(outputPaths('alpha/puzzle').progress(1), outputPaths('beta/puzzle').progress(1))
		assert.equal(custom.lock, paths.lock)
		writeCircuit(custom.latest, 4, singleGate)
		assert.deepEqual(loadJob('original').inputCircuit.gates, initialJob.originalCircuit.gates)
	} finally { Object.assign(jobConfig.files, savedPaths) }
	const { summarySeconds, checkpointSeconds } = jobConfig.timing
	try {
		Object.assign(jobConfig.timing, { summarySeconds: 10, checkpointSeconds: 55 })
		assert.match(describeJob('original', 'original', initialJob), /Checkpoints: every 55 seconds/)
	} finally {
		Object.assign(jobConfig.timing, { summarySeconds, checkpointSeconds })
	}
	writeCircuit(paths.latest, 4, [{ ...singleGate[0], target: 4 }])
	assert.throws(() => loadJob('original'), /Invalid gate at index 0.*original-latest\.json/)
	assert.equal(loadJob('original', 'original', true).inputCircuit.gates.length, 1)
	assert.match(summary, /Worker limit:/)
	assert.match(summary, /1500 seconds/)
	assert.match(summary, /4 wires, up to 5 gates/)
	assert.deepEqual(await realPool.run([], 4), [])
	assert.deepEqual(await realPool.run([], 4), [])
} finally {
	await realPool.close()
	process.chdir(originalCwd)
	await rm(temporaryDirectory, { recursive: true, force: true })
}
const { formatProgress, logVerbose } = await import('./logging.js')
assert.match(formatProgress(1000, 900, 1, 4, 60_000), /1\/4 chunks completed; 900 candidate gates \(100 removed, 100\/min\)/)
assert.ok(!formatProgress(0, 0, 0, 0, 0).includes('NaN'))
const previousVerbose = process.env.OPTIMIZER_VERBOSE
const originalLog = console.log
const messages: unknown[][] = []
try {
	console.log = (...args: unknown[]) => { messages.push(args) }
	process.env.OPTIMIZER_VERBOSE = '0'
	for (let i = 0; i < 100; i++) logVerbose('per-replacement detail')
	assert.equal(messages.length, 0)
	process.env.OPTIMIZER_VERBOSE = '1'
	logVerbose('per-replacement detail')
	assert.equal(messages.length, 1)
} finally {
	console.log = originalLog
	if (previousVerbose === undefined) delete process.env.OPTIMIZER_VERBOSE
	else process.env.OPTIMIZER_VERBOSE = previousVerbose
}
console.log('Performance and correctness regressions passed')

// Compare indexed subset selection to the former forward scans.
const { referenceDependencySort } = await import('./test-reference.js')
const { dependencySort, dependencyGraphToMap, indexWireAccesses, mapCircuit, mapVariablesToIndexes } = await import('./utils.js')
const { findMatchingOperation } = await import('./processing.js')
for (let trial = 0; trial < 60; trial++) {
	const gates = makeGates(50, 8)
	const nodes = createDependencyGraph(gates)
	const map = dependencyGraphToMap(nodes)
	const access = indexWireAccesses(gates)
	for (const node of nodes) for (const size of [2, 8, 30]) {
		assert.deepEqual(dependencySort(map, node, size, nodes, gates, access), referenceDependencySort(map, node, size, nodes, gates))
	}
	const mapping = mapVariablesToIndexes(gates)
	const referenceMapping = gates.map(gate => ({ a: Math.max(0, mapping.indexOf(gate.a)), b: Math.max(0, mapping.indexOf(gate.b)), target: mapping.indexOf(gate.target), gate_i: gate.gate_i }))
	assert.deepEqual(mapCircuit(gates, mapping), referenceMapping)
	// Enumerate every pair independently, preserving the original match ordering.
	const matches: { gateIndex1: number, gateIndex2: number, matchingVariable: number }[] = []
	for (let i = 0; i < gates.length; i++) for (let j = i + 1; j < gates.length; j++) {
		if (gates[i].target !== gates[j].target) continue
		const a = getVars(gates[i]), b = getVars(gates[j])
		if (gates[i].gate_i === 15 && gates[j].gate_i === 15) { matches.push({ gateIndex1: i, gateIndex2: j, matchingVariable: a[0] }); continue }
		if (a.length !== b.length) continue
		for (const [x,y] of [[1,1],[1,2],[2,1],[2,2]]) {
			if (a[x] !== undefined && a[x] === b[y]) { matches.push({ gateIndex1: i, gateIndex2: j, matchingVariable: a[x] }); break }
		}
	}
	assert.deepEqual(findMatchingOperation(gates), matches[0])
}
for (const wires of [8, 64]) {
	// Identity outputs reveal the exact fixed test inputs without changing the seed.
	const inputs: boolean[][] = []
	assert.equal(areCircuitsProbabilisticallyTheSame(inputs, [], [], 202, wires), true)
	for (let trial = 0; trial < 20; trial++) {
		const old = makeGates(20, wires)
		const candidate = trial % 2 ? old : makeGates(20, wires)
		for (const attempts of [0, 1, 31, 32, 33, 202]) {
			const expected = inputs.slice(0, attempts).every(input => JSON.stringify(evalCircuit(old, input)) === JSON.stringify(evalCircuit(candidate, input)))
			assert.equal(areCircuitsProbabilisticallyTheSame([], old, candidate, attempts, wires), expected)
		}
	}
	// Ensure rejection can happen after the initial scalar input has passed.
	const control = inputs[0].findIndex((value, wire) => inputs.slice(1).some(input => input[wire] !== value))
	assert.ok(control >= 0)
	const candidate = [{ a: control, b: 0, target: (control + 1) % wires, gate_i: inputs[0][control] ? 12 : 3 }]
	assert.equal(areCircuitsProbabilisticallyTheSame([], [], candidate, 1, wires), true)
	assert.equal(areCircuitsProbabilisticallyTheSame([], [], candidate, 202, wires), false)
}
assert.equal(findMatchingOperation([]), undefined)
const copyDir = await mkdtemp(join(tmpdir(), 'deobfuscator-copies-'))
try {
	const { writeCircuitCopies } = await import('./storage.js')
	const paths = [join(copyDir, 'progress', 'checkpoint.json'), join(copyDir, 'latest.json')]
	let serialized = 0
	const gate = { ...singleGate[0], get a() { serialized++; return singleGate[0].a } }
	writeCircuitCopies([...paths, paths[0]], 4, [gate])
	assert.equal(serialized, 1)
	assert.equal(readFileSync(paths[0], 'utf8'), readFileSync(paths[1], 'utf8'))
} finally { await rm(copyDir, { recursive: true, force: true }) }
console.log('Additional candidate and dependency regressions passed')

// Repeated native database initialization and shutdown must not race.
const workerDir = await mkdtemp(join(tmpdir(), 'deobfuscator-lifecycle-'))
try {
	process.chdir(workerDir)
	for (let i = 0; i < 5; i++) {
		const pool = new WorkerPool(1)
		try { assert.deepEqual(await pool.run([], 4), []) }
		finally { await pool.close() }
	}
} finally {
	process.chdir(originalCwd)
	await rm(workerDir, { recursive: true, force: true })
}

const { defaults, parseConfig, config } = await import('./config.js')
const { formatWorkerActivity, shouldFinishReducedRound } = await import('./logging.js')
const status = { activity: { passes: 3, subsets: 120, checks: 900, improvements: 4, stage: 'searching' as const }, updatedAtMs: 5_000, done: false }
const detail = formatWorkerActivity([status, { updatedAtMs: 0, done: true }], 10_000, 25 * 60_000)
assert.match(detail, /3 passes, 120 subsets visited, 900 optimization checks, 4 improving rewrites/)
assert.match(detail, /1 searching/)
assert.match(detail, /1 completed/)
assert.match(detail, /5s ago/)
const improvedRoundMs = config.timing.improvedRoundSeconds * 1000
assert.equal(shouldFinishReducedRound(improvedRoundMs - 1, 100, 99), false)
assert.equal(shouldFinishReducedRound(improvedRoundMs, 100, 99), true)
assert.equal(shouldFinishReducedRound(improvedRoundMs, 100, 100), false)
const { ReductionCheckpoint } = await import('./storage.js')
const writes: number[] = []
const checkpoint = new ReductionCheckpoint(3, gates => { writes.push(gates.length) })
const candidate = [singleGate[0], singleGate[0], singleGate[0]]
assert.equal(checkpoint.saveIfReduced(candidate), false)
assert.equal(checkpoint.saveIfReduced(candidate.slice(0, 2)), true)
assert.equal(checkpoint.saveIfReduced(candidate.slice(0, 2)), false)
assert.equal(checkpoint.saveIfReduced(candidate.slice(0, 1)), true)
assert.deepEqual(writes, [2, 1])
let fail = true
const retryCheckpoint = new ReductionCheckpoint(3, () => { if (fail) throw new Error('verification failed') })
assert.throws(() => retryCheckpoint.saveIfReduced([]), /verification failed/)
assert.equal(retryCheckpoint.hasSaved, false)
fail = false
assert.equal(retryCheckpoint.saveIfReduced([]), true)
const stopDirectory = await mkdtemp(join(tmpdir(), 'deobfuscator-stop-'))
const stoppedPool = new WorkerPool(1)
try {
	process.chdir(stopDirectory)
	const signal = new Int32Array(new SharedArrayBuffer(4))
	const activities: string[] = []
	const result = await stoppedPool.run(singleGate, 4, (_, activity) => { if (activity) { activities.push(activity.stage); Atomics.store(signal, 0, 1) } }, signal.buffer as SharedArrayBuffer)
	assert.deepEqual(result, singleGate)
	assert.ok(activities.includes('searching'))
	assert.ok(activities.includes('verifying'))
} finally {
	await stoppedPool.close()
	process.chdir(originalCwd)
	await rm(stopDirectory, { recursive: true, force: true })
}
console.log('Detailed progress, reduction checkpoints and round-stop regressions passed')

assert.deepEqual(parseConfig({}), defaults)
const { parseConfigDocument } = await import('./config-document.js')
assert.doesNotThrow(() => parseConfig(parseConfigDocument(readFileSync(new URL('../solver.config.jsonc', import.meta.url), 'utf8'))))
const grouped = parseConfig(parseConfigDocument('{ // comment\n "strategies": {"truthTableLookup":{"enabled":false,},"variableElimination":{"samples":12},"satSweeping":{"enabled":false}}, "files":{"databaseDirectory":"https://example.test/tables"} }'))
assert.equal(grouped.search.rainbow, false)
assert.equal(grouped.validation.probabilisticInputs, 12)
assert.equal(grouped.synthesis.satSweeping, false)
assert.equal(grouped.files.databaseDirectory, 'https://example.test/tables')
assert.throws(() => parseConfig({ strategies: { rainbow: { enabld: false } } }), /Unknown config setting/)
assert.throws(() => parseConfigDocument('{"workers": /* unfinished'))
assert.equal(parseConfig({ synthesis: { satSweeping: false } }).synthesis.satSweeping, false)
const custom = parseConfig({ timing: { summarySeconds: 10, improvedRoundSeconds: 120 }, workers: { maximum: 3 }, logging: { verbose: true } })
assert.equal(custom.timing.summarySeconds, 10)
assert.equal(custom.timing.improvedRoundSeconds, 120)
const oldTiming = parseConfig({ timing: { roundMinutes: 2, improvedRoundMinutes: 1 }, logging: { eventLoopResolutionMilliseconds: 20 }, database: { lookupBatchMilliseconds: 15 } })
assert.equal(oldTiming.timing.roundSeconds, 120)
assert.equal(oldTiming.timing.improvedRoundSeconds, 60)
assert.equal(oldTiming.logging.eventLoopResolutionSeconds, 0.02)
assert.equal(oldTiming.database.lookupBatchSeconds, 0.015)
assert.equal(parseConfig({ timing: { roundMinutes: 2, roundSeconds: 90, improvedRoundSeconds: 30 } }).timing.roundSeconds, 90)
assert.equal(custom.workers.maximum, 3)
assert.deepEqual(custom.database.tables, defaults.database.tables)
assert.equal(defaults.timing.summarySeconds, 30)
for (const invalid of [{ files: { working: 'job.json' } }, { files: { original: 'source.json' } }, null, [], { typo: {} }, { timing: { typo: 5 } }, { workers: { maximum: 0 } }, { workers: { maximum: 1.5 } }, { timing: { summarySeconds: '30' } }, { search: { subsetMinimum: 100, subsetMaximum: 2 } }, { timing: { improvedRoundMinutes: 30 } }, { files: { workerDirectory: '../elsewhere' } }, JSON.parse('{"__proto__":{}}')]) {
	assert.throws(() => parseConfig(invalid))
}
// Worker configuration is carried in workerData, independent of its cwd.
const configFixture = new URL('data:text/javascript,' + encodeURIComponent(`
import { parentPort, workerData } from 'node:worker_threads';
parentPort.on('message', () => parentPort.postMessage({gates:[{a:workerData.solverConfig.timing.summarySeconds,b:0,target:0,gate_i:0}]}));
`))
const configPool = new WorkerPool(1, configFixture)
try { assert.equal((await configPool.run([], 1))[0].a, config.timing.summarySeconds) }
finally { await configPool.close() }
console.log('JSON configuration regressions passed')

const { execFileSync, spawnSync } = await import('node:child_process')
const { fileURLToPath } = await import('node:url')
const configDir = await mkdtemp(join(tmpdir(), 'deobfuscator-config-'))
try {
	const { writeFileSync } = await import('node:fs')
	const customPath = join(configDir, 'custom.json')
	writeFileSync(customPath, JSON.stringify({ timing: { improvedRoundMinutes: 2, summarySeconds: 10 }, files: { dataDirectory: 'custom-data' }, search: { sliceMinimum: 3 } }))
	const script = `
		import {config} from ${JSON.stringify(new URL('./config.js', import.meta.url).href)};
		import {outputPaths} from ${JSON.stringify(new URL('./storage.js', import.meta.url).href)};
		import {shouldFinishReducedRound} from ${JSON.stringify(new URL('./logging.js', import.meta.url).href)};
		console.log(JSON.stringify({seconds:config.timing.summarySeconds, path:outputPaths('task').latest, finish:shouldFinishReducedRound(120000, 10, 9)}));
	`
	const result = JSON.parse(execFileSync(process.execPath, ['--input-type=module', '-e', script], { env: { ...process.env, OPTIMIZER_CONFIG: customPath }, encoding: 'utf8' }))
	assert.equal(result.seconds, 10)
	assert.equal(result.path, 'task-latest.json')
	assert.equal(result.finish, true)
	const launch = spawnSync(process.execPath, [fileURLToPath(new URL('./launch.js', import.meta.url)), '--unknown-option'], { encoding: 'utf8' })
	assert.equal(launch.status, 1)
	assert.match(launch.stderr, /Usage:/)
	const missingInputs = spawnSync(process.execPath, [fileURLToPath(new URL('./launch.js', import.meta.url))], { encoding: 'utf8' })
	assert.equal(missingInputs.status, 1)
	assert.match(missingInputs.stderr, /Usage:/)
} finally { await rm(configDir, { recursive: true, force: true }) }

const { IncrementalEvaluator, PackedInputs } = await import('./packed.js')
const { RewriteCache, normalizeWindow, SearchScheduler, balancedChunks, improving } = await import('./search.js')
const { isReplacementSimpler, findConvexSubsets } = await import('./utils.js')
for (const wires of [1, 4, 8]) {
	const combinations = generateCombinations(wires)
	for (const count of [0, 1, 17, 32, 33, 64, 202]) {
		const inputs = Array.from({ length: count }, (_, i) => combinations[i % combinations.length])
		const packedInputs = new PackedInputs(inputs)
		const reference = makeGates(45, wires)
		for (const bytes of [0, 64, 8192]) {
			const evaluator = new IncrementalEvaluator(reference, bytes === 0 ? inputs : packedInputs, bytes, 4)
			assert.deepEqual(evaluator.unpack(), inputs.map(input => evalCircuit(reference, input)))
			assert.ok([...evaluator.checkpoints.values()].reduce((sum, state) => sum + state.byteLength, 0) <= bytes)
			const variants = [reference, [], reference.slice(1), reference.slice(0, -1), [...reference, ...makeGates(1, wires)], [...reference.slice(0, 30), ...makeGates(1, wires), ...reference.slice(31)]]
			for (const candidate of variants) {
				const expected = inputs.map(input => evalCircuit(candidate, input))
				assert.deepEqual(evaluator.unpack(evaluator.evaluate(candidate)), expected)
				assert.equal(evaluator.equivalent(candidate), JSON.stringify(expected) === JSON.stringify(inputs.map(input => evalCircuit(reference, input))))
			}
		}
	}
}
const rewriteCache = new RewriteCache(100)
let computations = 0
for (let f = 0; f < 16; f++) {
	const gate = { a: 0, b: 1, target: 2, gate_i: f }
	const first = [gate, gate]
	const renamed = first.map(gate => ({ a: 5, b: 2, target: 4, gate_i: gate.gate_i }))
	assert.equal(normalizeWindow(first).key, normalizeWindow(renamed).key)
	for (const circuit of [first, renamed]) {
		const replacement = rewriteCache.resolve(circuit, () => { computations++; return [] })
		assert.deepEqual(replacement, [])
		for (const input of generateCombinations(6)) assert.deepEqual(evalCircuit(circuit, input), evalCircuit(replacement!, input))
	}
}
assert.equal(computations, 16)
const misses = new RewriteCache(2)
let failures = 0
for (let i = 0; i < 2; i++) assert.equal(misses.resolve(singleGate, () => { failures++; return undefined }), undefined)
assert.equal(failures, 1)
for (let i = 0; i < 100; i++) {
	const before = makeGates(random(20), 8), after = makeGates(random(20), 8)
	assert.equal(improving(before)(after), isReplacementSimpler(after, before))
}
const scheduler = new SearchScheduler(3)
const arms = [{ subset: 3, slice: 2, method: 'all' as const }, { subset: 5, slice: 3, method: 'truth-table-lookup' as const }]
scheduler.record(arms[0], 100, 1)
scheduler.record(arms[1], 10, 10)
assert.deepEqual(scheduler.choose(arms, () => 0), arms[1])
assert.deepEqual(scheduler.choose(arms, () => 0), arms[1])
assert.deepEqual(scheduler.choose(arms, () => 0), arms[0]) // forced exploration
assert.throws(() => scheduler.choose([]))
const training = new SearchScheduler(2)
training.record(arms[0], 1, 1)
training.choose(arms, () => 0)
assert.deepEqual(training.choose(arms, () => 0), arms[1]) // explore an untried method
const gatesToBalance = makeGates(100, 8)
for (const count of [1, 2, 16, 200]) {
	const chunks = balancedChunks(gatesToBalance, count, new Map([[0, 100], [1, 1]]))
	assert.ok(chunks.every(chunk => chunk.length > 0))
	assert.equal(chunks.length, Math.min(count, gatesToBalance.length))
	assert.deepEqual(chunks.flat(), gatesToBalance)
	for (const input of generateCombinations(8)) assert.deepEqual(evalCircuit(chunks.flat(), input), evalCircuit(gatesToBalance, input))
}
assert.deepEqual(balancedChunks([], 4), [])
// A changed-wire preference affects traversal order, not the set of available subsets.
const savedRandom = Math.random
try {
	Math.random = () => 0.5
	const baseline = [...findConvexSubsets(3, gatesToBalance)]
	Math.random = () => 0.5
	const preferred = [...findConvexSubsets(3, gatesToBalance, new Set([0]))]
	assert.deepEqual(preferred.map(lines => lines.join(',')).sort(), baseline.map(lines => lines.join(',')).sort())
	// The selector partitions seeds, not the gates inside each returned region.
	const favored = baseline.filter(lines => getVars(gatesToBalance[Math.max(...lines)]).includes(0))
	const others = baseline.filter(lines => !getVars(gatesToBalance[Math.max(...lines)]).includes(0))
	assert.deepEqual(preferred, [...favored, ...others])
} finally { Math.random = savedRandom }
console.log('Adaptive, incremental, packed, normalized-cache, pruning and balancing regressions passed')

// Exercise the actual rewrite and subset-search paths with a tiny SQLite table.
const { massOptimizeStep, optimizeSubset } = await import('./processing.js')
const { ioHash } = await import('./utils.js')
const integrationDb = new sqlite3.Database(':memory:')
const integrationPortfolio = new RainbowPortfolio([{ db: integrationDb, wires: 4, gates: 5 }])
const runSql = (sql: string, params: unknown[] = []) => new Promise<void>((resolve, reject) => integrationDb.run(sql, params, error => error ? reject(error) : resolve()))
try {
	await runSql('CREATE TABLE InputOutputReplacers (ioIdentifier BLOB PRIMARY KEY, replacerGates BLOB NOT NULL)')
	const inputs = generateCombinations(4)
	await runSql('INSERT INTO InputOutputReplacers VALUES (?, ?)', [Buffer.from(ioHash(inputs.flat()), 'hex'), Buffer.alloc(0)])
	const cnot = { a: 1, b: 0, target: 0, gate_i: 3 }
	const circuit = Array.from({ length: 8 }, () => ({ ...cnot }))
	const result = await massOptimizeStep(integrationPortfolio, new LimitedMap(100), new LimitedMap(100), circuit, 2, false, false)
	assert.ok(result.gates.length < circuit.length)
	assert.deepEqual(inputs.map(input => evalCircuit(result.gates, input)), inputs.map(input => evalCircuit(circuit, input)))
	for (const offset of [0, 4]) {
		const identity = Array.from({ length: 6 }, (_, i) => ({ a: 0, b: 0, target: offset + i % 2, gate_i: 0 }))
		const exact = await massOptimizeStep(integrationPortfolio, new LimitedMap(100), new LimitedMap(100), identity, 3, false, true, false)
		assert.ok(exact.gates.length < identity.length)
		assert.deepEqual(generateCombinations(6).map(input => evalCircuit(exact.gates, input)), generateCombinations(6).map(input => evalCircuit(identity, input)))
	}
	await runSql('DELETE FROM InputOutputReplacers')
	const { RoundStrategyPicker } = await import('./strategy-picker.js')
	const not = { a: 0, b: 0, target: 0, gate_i: 15 }
	const oneWireIdentity = [not, not, not, not]
	const oneWire = await massOptimizeStep(integrationPortfolio, new LimitedMap(100), new LimitedMap(100), oneWireIdentity, 4, true, true, false, undefined, undefined, new RoundStrategyPicker(['variable-elimination']))
	assert.deepEqual(oneWire.gates, [], 'the variables strategy cancels a one-wire identity')
	const toggle = (a: number, target: number): Gate => ({ a, b: 0, target, gate_i: 3 })
	const padding = Array.from({ length: 61 }, (_, i) => ({ ...not, target: 3 + i }))
	const scratch = [toggle(0, 1), toggle(1, 2), ...padding, toggle(1, 2), toggle(0, 1)]
	const scratchInputs = generateCombinations(3).map(input => [...input, ...padding.map(() => false)])
	const variableCaches = { ...createOptimizerCaches(), strategyPicker: new RoundStrategyPicker(['variable-elimination']) }
	const reducedScratch = await optimize(integrationPortfolio, scratch, 64, 'repeated-write-test', true, variableCaches,
		5000, undefined, undefined, undefined, false, 2, true)
	assert.deepEqual(reducedScratch, padding, 'the repeated-write cut removes the temporary wire across unrelated gates')
	assert.deepEqual(calculateAllOutputsArray(reducedScratch, scratchInputs), calculateAllOutputsArray(scratch, scratchInputs))

	const observableScratch = [toggle(0, 1), toggle(1, 2), ...padding, toggle(0, 1)]
	const keptScratch = await optimize(integrationPortfolio, observableScratch, 64, 'observable-write-test', true, variableCaches,
		5000, undefined, undefined, undefined, false, 2, true)
	assert.equal(keptScratch.length, observableScratch.length, 'a temporary value observed on another wire cannot be dropped')
	assert.deepEqual(calculateAllOutputsArray(keptScratch, scratchInputs), calculateAllOutputsArray(observableScratch, scratchInputs))
	const tested = new LimitedMap<string, boolean>(1000)
	const processed = new LimitedMap<string, boolean>(1000)
	const lookups = new LimitedMap<string, Gate[] | null>(1000)
	const counters = () => ({ passes: 0, subsets: 0, checks: 0, improvements: 0, stage: 'searching' as const })
	const first = counters(), second = counters()
	const unchanged = circuit.map((gate, i) => ({ ...gate, a: i % 2, target: 1 - i % 2 }))
	await optimizeSubset(integrationPortfolio, unchanged, lookups, processed, 3, 2, 'heavy', () => false, first, () => {}, tested, 'truth-table-lookup')
	await optimizeSubset(integrationPortfolio, unchanged, lookups, processed, 3, 2, 'heavy', () => false, second, () => {}, tested, 'truth-table-lookup')
	assert.ok(first.checks > 0)
	assert.equal(second.checks, 0)
} finally { await closeRainbowTable(integrationDb) }
console.log('Solver integration regressions passed')

const { formatStatus, SummaryThrottle } = await import('./logging.js')
const summaryThrottle = new SummaryThrottle(30_000)
assert.equal(summaryThrottle.allow(0), true)
for (let round = 1; round < 30; round++) assert.equal(summaryThrottle.allow(round * 1000), false, 'quiet cadence survives rapid round restarts')
assert.equal(summaryThrottle.allow(30_000), true)
assert.equal(summaryThrottle.allow(30_001, true), true, 'verbose and final reports bypass the interval')
const compact = formatStatus({ pairUses: 12, previousPairs: 15, original: 1000, roundStart: 200, candidate: 100, previous: 163, statuses: [status, { updatedAtMs: 0, done: true }], elapsedMs: 60_000 })
assert.match(compact, /Circuit: 100G 12P -63G -3P \(90\.00%\)/)
assert.ok(!compact.includes('Checkpoint'))
assert.match(compact, /1 worker active/)
assert.ok(compact.endsWith(`Round time: 1m 0s / ${Math.floor(improvedRoundMs / 60_000)}m ${Math.floor(improvedRoundMs / 1000) % 60}s`))
assert.ok(!compact.includes('oldest'))
assert.ok(!compact.includes('subsets'))
const strategyStatus = formatStatus({
	pairUses: 12, previousPairs: 15, original: 1000, roundStart: 200, candidate: 100, previous: 163, elapsedMs: 60_000,
	statuses: [
		{ ...status, activity: { ...status.activity, strategies: [
			{ strategy: 'sat-sweeping', settings: '{}', attempts: 4, rewrites: 1, gatesRemoved: 4, elapsedMs: 100 },
			{ strategy: 'smt-synthesis', settings: '{}', attempts: 4, rewrites: 2, gatesRemoved: 6, elapsedMs: 100 },
		] } },
		{ ...status, done: true, activity: { ...status.activity, strategies: [
			{ strategy: 'sat-sweeping', settings: '{"limit":2}', attempts: 4, rewrites: 1, gatesRemoved: 4, elapsedMs: 100 },
		] } },
	],
})
assert.match(strategyStatus, / \| Top: SAT sweep$/)
const completedStatus = formatStatus({ pairUses: 12, previousPairs: 10, original: 100, roundStart: 100, candidate: 50, previous: 60, statuses: [{ updatedAtMs: 0, done: true }], elapsedMs: 300_000 })
assert.match(completedStatus, /All workers finished/)
assert.match(completedStatus, /Round finished in 5m 0s/)
assert.ok(!completedStatus.includes('% elapsed'))
assert.match(completedStatus, /Circuit: 50G 12P -10G \+2P/)
const lateStatus = formatStatus({ pairUses: 12, previousPairs: 12, original: 100, roundStart: 100, candidate: 100, previous: 100, statuses: [status], elapsedMs: 90_000 })
assert.match(lateStatus, /Warning: 1 worker update delayed/)
assert.match(lateStatus, /Round time: 1m 30s \/ 25m 0s/)
assert.ok(!formatStatus({ pairUses: 0, previousPairs: 0, original: 0, roundStart: 0, candidate: 0, previous: 0, statuses: [], elapsedMs: 0 }).includes('NaN'))

const { functionKey, circuitState, semanticCircuits, meetInMiddle, encodeGates, decodeGates, truthKey } = await import('./semantic.js')
const { saturateCircuit, CircuitEqualityGraph } = await import('./equality.js')
for (let f = 0; f < 16; f++) for (let h = 0; h < 16; h++) {
	const gates = [{ a: 0, b: 1, target: 2, gate_i: f }, { a: 1, b: 0, target: 2, gate_i: h }]
	assert.deepEqual(decodeGates(encodeGates(gates)), gates)
}
const unsafe = [{ a: 0, b: 1, target: 0, gate_i: 3 }, { a: 0, b: 1, target: 0, gate_i: 3 }]
const not0 = { a: 0, b: 0, target: 0, gate_i: 15 }, not1 = { a: 0, b: 0, target: 1, gate_i: 15 }
const separated = [not0, not1, not0]
const saturated = saturateCircuit(separated, 2, 100, 500)
assert.ok(saturated && saturated.length < separated.length)
assert.equal(functionKey(saturated!, 2), functionKey(separated, 2))
const egraph = new CircuitEqualityGraph()
assert.equal(egraph.add([not0, not0], 2), egraph.add([], 2))
const catalog = [not0, not1, { a: 1, b: 0, target: 0, gate_i: 3 }]
const semantic = [...semanticCircuits(2, 3, catalog, 10000)]
let brute: Gate[][] = [[]]
for (let depth = 1, layer: Gate[][] = [[]]; depth <= 3; depth++) { layer = layer.flatMap(sequence => catalog.map(gate => [...sequence, gate])); brute.push(...layer) }
const cheapest = (circuits: Gate[][]) => {
	const map = new Map<string, Gate[]>()
	for (const gates of circuits) { const key = functionKey(gates, 2), old = map.get(key); if (!old || isReplacementSimpler(gates, old)) map.set(key, gates) }
	return map
}
const exhaustive = cheapest(brute), deduplicated = cheapest(semantic)
assert.equal(exhaustive.size, deduplicated.size)
for (const [key, gates] of exhaustive) {
	assert.equal(deduplicated.get(key)!.length, gates.length)
	assert.equal(isReplacementSimpler(gates, deduplicated.get(key)!), false)
}
assert.throws(() => [...semanticCircuits(2, 3, catalog, 1)], /limit/)
const middle = meetInMiddle([not0, not0, not0], 2, catalog, 2, 100, 500)
assert.ok(middle && middle.length === 1)
assert.equal(functionKey(middle!, 2), functionKey([not0], 2))
assert.equal(meetInMiddle(unsafe, 2, catalog, 2, 100, 500), undefined)
assert.equal(truthKey(generateCombinations(4).flat()).length, 8)
const { forwardSemanticSearch } = await import('./semantic.js')
const forwardResult = forwardSemanticSearch([singleGate[0], singleGate[0], singleGate[0]], 2, 1, 2000, 5000)
assert.ok(forwardResult && forwardResult.length === 1)
assert.equal(functionKey(forwardResult!, 2), functionKey(singleGate, 2))
const erased = forwardSemanticSearch(unsafe, 2, 1, 2000, 5000)
assert.ok(erased && erased.length === 1)
assert.equal(functionKey(erased!, 2), functionKey(unsafe, 2))
assert.deepEqual(forwardSemanticSearch([not0, not0], 2, 1, 2000, 5000), [])
assert.equal(forwardSemanticSearch([not0, not1], 2, 1, 2000, 5000), undefined)
assert.equal(forwardSemanticSearch([not0, not1, not0], 2, 2, 0, 5000), undefined)
assert.equal(forwardSemanticSearch([not0, not1, not0], 2, 2, 2000, 0), undefined)
assert.throws(() => forwardSemanticSearch(unsafe, 5, 1, 2000, 5000))
// Every two-wire single-gate transformation, including repeated controls and
// non-bijective gates, must be recoverable from an equivalent padded circuit.
const allSingle = new Map<string, Gate>()
for (let a = 0; a < 2; a++) for (let b = 0; b < 2; b++) for (let target = 0; target < 2; target++) for (let gate_i = 0; gate_i < 16; gate_i++) {
	const gate = { a, b, target, gate_i }
	allSingle.set(functionKey([gate], 2), gate)
}
for (const gate of allSingle.values()) {
	const padded = [gate, not0, not0]
	const result = forwardSemanticSearch(padded, 2, 1, 2000, 5000)
	assert.ok(result)
	assert.equal(functionKey(result!, 2), functionKey(padded, 2))
}
const pair = [singleGate[0], not0]
const pairResult = forwardSemanticSearch([...pair, not1, not1], 2, 2, 2000, 5000)
assert.ok(pairResult && pairResult.length === 2)
assert.deepEqual(circuitState(pairResult!, 2), circuitState(pair, 2))
const { resetStrategyStats, recordStrategy, strategySnapshot } = await import('./strategy-stats.js')
const { formatStrategyActivity } = await import('./logging.js')
resetStrategyStats()
recordStrategy('forward-semantic-search', { states: 2000 }, performance.now(), 4, 2, true)
recordStrategy('forward-semantic-search', { states: 2000 }, performance.now(), 4, 4, false)
const activityStats = { passes: 0, subsets: 0, checks: 0, improvements: 0, stage: 'searching' as const, strategies: strategySnapshot() }
const summary = formatStrategyActivity([{ activity: activityStats, updatedAtMs: 0, done: true }, { activity: activityStats, updatedAtMs: 0, done: false }])
assert.match(summary, /4 gates removed, 2\/4 improving attempts/)
assert.match(summary, /"states":2000/)
assert.match(formatStrategyActivity([]), /awaiting worker reports/)
resetStrategyStats()
assert.deepEqual(strategySnapshot(), [])
assert.equal(parseConfig({}).synthesis.smt, true)
assert.equal(parseConfig({}).synthesis.forwardSemanticSearch, true)
assert.equal(parseConfig({}).synthesis.meetInMiddle, true)
assert.equal(parseConfig({}).synthesis.equalitySaturation, true)
assert.equal(parseConfig({ synthesis: { forwardSemanticSearch: true } }).synthesis.forwardSemanticSearch, true)

// A failed forward semantic search attempt must leave Z3 eligible on exactly the same window.
const { advancedRewrite } = await import('./strategies.js')
const synthesisOptions = { ...config.synthesis }
try {
	Object.assign(config.synthesis, { factored: false, blockCancellation: false, satSweeping: false, mixedBasis: false, quadratic: false, affine: false, forwardSemanticSearch: true, smt: true, meetInMiddle: false, equalitySaturation: false, maximumWires: 3, states: 2000, maximumReplacementGates: 0 })
	const input = [singleGate[0], singleGate[0], singleGate[0]]
	resetStrategyStats()
	assert.equal(await advancedRewrite(input, { deadline: performance.now() + 5000 }), undefined)
	assert.equal(strategySnapshot().length, 1)
	assert.equal(await advancedRewrite(input, { deadline: performance.now() + 5000 }), undefined)
	assert.deepEqual(new Set(strategySnapshot().map(stat => stat.strategy)), new Set(['forward-semantic-search', 'smt-synthesis']))
	const count = strategySnapshot().reduce((sum, stat) => sum + stat.attempts, 0)
	assert.equal(await advancedRewrite(input, { deadline: performance.now() + 5000 }), undefined)
	assert.equal(strategySnapshot().reduce((sum, stat) => sum + stat.attempts, 0), count)
	// Rotation continues predictably on a different window.
	config.synthesis.maximumReplacementGates = 1
	const recovered = await advancedRewrite([not0, not0, not0], { deadline: performance.now() + 5000 })
	assert.ok(recovered && recovered.length === 1)
	assert.equal(functionKey(recovered!, 2), functionKey([not0], 2))
	assert.ok(['smt-synthesis', 'forward-semantic-search'].includes(strategySnapshot()[strategySnapshot().length - 1].strategy))
} finally {
	Object.assign(config.synthesis, synthesisOptions)
	resetStrategyStats()
}
console.log('Semantic generation, meet-in-the-middle, equality graph, forward semantic search and strategy summary regressions passed')

assert.equal(parseConfig({ database: { memoryMapBytes: 0 } }).database.memoryMapBytes, 0)
assert.throws(() => parseConfig({ database: { format: 'unknown' } }))
assert.throws(() => parseConfig({ synthesis: { maximumWires: 5 } }))

const { generateOnDisk } = await import('./disk-generation.js')
const { runSQL, allSQL } = await import('./sql.js')
const diskDirectory = await mkdtemp(join(tmpdir(), 'deobfuscator-frontier-'))
const options = { readRows: 2, stageRows: 3, parameterLimit: 20, stateLimit: 0, keepState: false }
const expectedEntries = new Map<string, Gate[]>()
for (const sequence of brute) {
	const key = ioHash(generateCombinations(2).flatMap(input => evalCircuit(sequence, input)))
	const old = expectedEntries.get(key)
	if (!old || isReplacementSimpler(sequence, old)) expectedEntries.set(key, sequence)
}
const openBuild = async (filename: string) => {
	const db = new sqlite3.Database(filename)
	await runSQL(db, generationLookupSchema)
	return db
}
const closeBuild = closeRainbowTable
const checkBuild = async (db: Database) => {
	const rows = await allSQL<{ ioIdentifier: Buffer, replacerGates: Buffer }>(db, 'SELECT * FROM InputOutputReplacers')
	assert.equal(rows.length, expectedEntries.size)
	for (const row of rows) {
		const gates = decodeGates(row.replacerGates), expected = expectedEntries.get(row.ioIdentifier.toString('hex'))!
		assert.ok(expected)
		assert.equal(functionKey(gates, 2), functionKey(expected, 2))
		assert.equal(isReplacementSimpler(expected, gates), false)
	}
}
try {
	const path = join(diskDirectory, 'resume.db')
	let db = await openBuild(path)
	let polls = 0
	assert.equal(await generateOnDisk(db, 2, 3, catalog, options, undefined, () => ++polls > 3), false)
	const checkpoint = (await allSQL<{ depth: number, processed: number }>(db, 'SELECT depth,processed FROM BuildMeta'))[0]
	assert.equal(checkpoint.depth, 1)
	assert.ok(checkpoint.processed > 0)
	await closeBuild(db)
	db = await openBuild(path)
	assert.equal(await generateOnDisk(db, 2, 3, catalog, options), true)
	await checkBuild(db)
	assert.equal((await allSQL(db, "SELECT name FROM sqlite_master WHERE name IN ('BuildSeen','BuildFrontier')")).length, 0)
	await closeBuild(db)
	const failure = await openBuild(join(diskDirectory, 'rollback.db'))
	await assert.rejects(generateOnDisk(failure, 2, 3, catalog, { ...options, beforeCommit: async () => { throw new Error('injected write failure') } }), /injected write failure/)
	assert.equal((await allSQL(failure, 'SELECT * FROM InputOutputReplacers')).length, 0)
	assert.equal((await allSQL<{ processed: number }>(failure, 'SELECT processed FROM BuildMeta'))[0].processed, 0)
	await generateOnDisk(failure, 2, 3, catalog, options)
	await checkBuild(failure)
	await closeBuild(failure)
	const limited = await openBuild(join(diskDirectory, 'limited.db'))
	await assert.rejects(generateOnDisk(limited, 2, 3, catalog, { ...options, stateLimit: 1 }), /state limit/)
	await generateOnDisk(limited, 2, 3, catalog, options)
	await checkBuild(limited)
	await closeBuild(limited)

} finally { await rm(diskDirectory, { recursive: true, force: true }) }
assert.deepEqual(mapVariablesToIndexes([{ a: 10, b: 2, target: 0, gate_i: 1 }]), [0, 2, 10])
console.log('Disk frontier resume, rollback, optimal-cost coverage, batching and fixed-label normalization regressions passed')

const { GenerationEstimator, formatGenerationProgress } = await import('./generation-progress.js')
const estimator = new GenerationEstimator(5, 3, .2)
const layer = (processed: number, depth = 2) => ({ depth, processed, total: 10000, states: processed })
assert.match(estimator.update(layer(100), 0), /learning/)
assert.match(estimator.update(layer(200), 60000), /learning/)
assert.match(estimator.update(layer(300), 120000), /learning/)
const steady = estimator.update(layer(400), 180000)
assert.ok(steady.startsWith('~'))
const spike = estimator.update(layer(401), 240000)
assert.equal(spike, steady) // one slow interval cannot multiply the ETA
assert.match(estimator.update(layer(0, 3), 300000), /learning/) // reset at new layer
const paused = new GenerationEstimator(5, 3, .2)
for (let i = 0; i < 5; i++) paused.update(layer(10), i * 60000)
assert.match(paused.update(layer(10), 300000), /waiting for progress/)
const resumedETA = new GenerationEstimator(5, 3, .2)
assert.match(resumedETA.update(layer(9000), 0), /learning/)
assert.match(resumedETA.update(layer(9010), 60000), /learning/)
assert.equal(formatGenerationProgress({ ...layer(5000), overallDone: 5000, overallTotal: 10000, overallEstimated: true }, 1000, '~5m'), 'Rainbow generation: ~50.00% complete | ETA ~5m')
assert.throws(() => parseConfig({ database: { etaSmoothing: 2 } }))
assert.throws(() => parseConfig({ database: { etaWarmupSamples: 10, etaWindowSamples: 5 } }))
assert.throws(() => parseConfig({ database: { format: 'legacy' } }))
assert.throws(() => parseConfig({ database: { semanticGeneration: false } }))
const newTableDirectory = await mkdtemp(join(tmpdir(), 'deobfuscator-single-table-'))
try {
	process.chdir(newTableDirectory)
	const { createRainbowTable, databaseFilename, getReplacersByIds } = await import('./rainbowtable.js')
	const generated = await createRainbowTable(2, 2)
	const cnRight = { a: 0, b: 0, target: 1, gate_i: 3 }
	const key = ioHash(generateCombinations(2).flatMap(input => evalCircuit([cnRight], input)))
	const matches = await getReplacersByIds(generated, new LimitedMap(10), [key])
	assert.equal(matches.length, 1)
	assert.equal(matches[0].gates.length, 1)
	assert.equal(functionKey(matches[0].gates, 2), functionKey([cnRight], 2))
	await closeBuild(generated)
	const snapshot = readFileSync(databaseFilename(2, 2))
	await closeBuild(await createRainbowTable(2, 2))
	assert.deepEqual(readFileSync(databaseFilename(2, 2)), snapshot)
} finally {
	process.chdir(originalCwd)
	await rm(newTableDirectory, { recursive: true, force: true })
}
console.log('Stable layer ETA and single-format generation regressions passed')

const { patchCircuit, LazyCircuit } = await import('./circuit-edit.js')
const { IncrementalGraph } = await import('./incremental-graph.js')
const { WindowFingerprints } = await import('./fingerprints.js')
const { LookupBatcher } = await import('./lookup-batcher.js')
for (let trial = 0; trial < 40; trial++) {
	let gates = makeGates(40, 8)
	const incremental = new IncrementalGraph(gates)
	for (let step = 0; step < 12; step++) {
		const context = incremental.context()
		assert.deepEqual(context.nodes, createDependencyGraph(gates))
		assert.deepEqual(context.dependantMap, dependencyGraphToMap(createDependencyGraph(gates)))
		assert.deepEqual(context.access, indexWireAccesses(gates))
		if (!gates.length) break
		const selected = [...new Set(Array.from({ length: 1 + random(5) }, () => random(gates.length)))]
		const replacement = makeGates(random(5), 8)
		const last = Math.max(...selected)
		const expected = [...gates.filter((_, i) => i <= last && !selected.includes(i)), ...replacement, ...gates.slice(last + 1)]
		const patch = patchCircuit(gates, selected, replacement)
		assert.deepEqual(patch.values, expected)
		assert.deepEqual(patch.values.slice(patch.start, patch.start + replacement.length), replacement)
		incremental.replace(selected, replacement)
		gates = patch.values
	}
	assert.deepEqual(incremental.context().nodes, createDependencyGraph(gates))
}
const lazy = new LazyCircuit([singleGate, singleGate])
assert.equal(lazy.length, 2)
const oldSnapshot = lazy.materialize()
assert.equal(lazy.materialize(), oldSnapshot)
lazy.update(1, [])
assert.equal(lazy.length, 1)
assert.deepEqual(oldSnapshot, [...singleGate, ...singleGate])
assert.deepEqual(lazy.materialize(), singleGate)
assert.notEqual(lazy.materialize(), oldSnapshot)
assert.throws(() => patchCircuit([1,2,3], [], [4]))
for (let trial = 0; trial < 10; trial++) {
	const gates = makeGates(25, 8), fingerprints = new WindowFingerprints(gates)
	const cache = new LimitedMap<string, boolean>(10000)
	for (let start = 0; start < gates.length; start++) for (let end = start; end <= gates.length; end++) {
		assert.equal(fingerprints.key(start, end), new WindowFingerprints(gates.slice(start, end)).key(0, end - start))
		fingerprints.remember(cache, start, end)
		assert.equal(fingerprints.seen(cache, start, end), true)
	}
}
const collisionA = new WindowFingerprints(singleGate), collisionB = new WindowFingerprints([{...singleGate[0], gate_i: 12}])
collisionA.key = () => 'collision'; collisionB.key = () => 'collision'
const collisions = new LimitedMap<string, boolean>(10)
collisionA.remember(collisions, 0, 1)
assert.equal(collisionB.seen(collisions, 0, 1), false)
collisionB.remember(collisions, 0, 1)
assert.equal(collisionA.seen(collisions, 0, 1), true)
const tinyCache = new LimitedMap<string, boolean>(10)
new WindowFingerprints(singleGate, 1).remember(tinyCache, 0, 1)
assert.equal(tinyCache.size(), 0)
let calls = 0
const batcher = new LookupBatcher(2, 0, async ids => { calls++; return new Map(ids.filter(id => id !== 'missing').map(id => [id, singleGate])) })
const shared = batcher.get('a')
assert.equal(batcher.get('a'), shared)
assert.deepEqual(await Promise.all([shared, batcher.get('b'), batcher.get('missing')]), [singleGate, singleGate, null])
assert.equal(calls, 2)
let resolveFetch!: (value: Map<string, Gate[]>) => void
const pendingLookup = new LookupBatcher(10, 0, () => new Promise(resolve => { resolveFetch = resolve }))
const inFlight = pendingLookup.get('same')
await Promise.resolve()
assert.equal(pendingLookup.get('same'), inFlight)
resolveFetch(new Map([['same', singleGate]]))
assert.deepEqual(await inFlight, singleGate)
const failingLookup = new LookupBatcher(10, 0, async () => { throw new Error('lookup failed') })
await assert.rejects(failingLookup.get('a'), /lookup failed/)
await assert.rejects(failingLookup.get('a'), /lookup failed/) // retry after rejection
const queuedStatus = formatStatus({ pairUses: 12, previousPairs: 12, original: 10, roundStart: 10, candidate: 10, previous: 10, statuses: [{updatedAtMs:0,done:false,started:false}], elapsedMs: 100000 })
assert.match(queuedStatus, /0 workers active; 1 job queued/)
assert.ok(!queuedStatus.includes('Warning'))
console.log('Circuit editing, local graph updates, lazy snapshots, verified rolling fingerprints and lookup coalescing regressions passed')

const schedulingFixture = new URL('data:text/javascript,' + encodeURIComponent(`
import {parentPort} from 'node:worker_threads';
parentPort.on('message', async ({gates,stopSignal,budgetMs}) => {
 const barrier=new Int32Array(stopSignal);
 parentPort.postMessage({progress:gates.length});
 Atomics.add(barrier,1,1);
 while(Atomics.load(barrier,1)<2) await new Promise(resolve=>setTimeout(resolve,1));
 await new Promise(resolve=>setTimeout(resolve,gates[0].a===0?80:2));
 parentPort.postMessage({gates:gates.map(gate=>({...gate,b:budgetMs}))});
});`))
const schedulingPool = new WorkerPool(2, schedulingFixture)
const schedulingSignal = new Int32Array(new SharedArrayBuffer(8))
try {
	const completedOrder: number[] = [], activeJobs = new Set<number>()
	let peak = 0
	const tasks = [0,1,2,3].map(id => schedulingPool.run([{a:id,b:0,target:0,gate_i:0}], 4, () => {
		activeJobs.add(id); peak = Math.max(peak, activeJobs.size)
	}, schedulingSignal.buffer as SharedArrayBuffer, 9).then(gates => { activeJobs.delete(id); completedOrder.push(id); return gates }))
	const results = await Promise.all(tasks)
	assert.deepEqual(results.map(gates => gates[0].a), [0,1,2,3])
	assert.ok(completedOrder.indexOf(1) < completedOrder.indexOf(0))
	assert.equal(peak, 2)
	assert.ok(results.every(gates => gates[0].b === 9))
} finally { await schedulingPool.close() }
const throwingProgressPool = new WorkerPool(1, new URL('data:text/javascript,' + encodeURIComponent(`
import {parentPort} from 'node:worker_threads';
parentPort.on('message', () => parentPort.postMessage({progress:1}));
`)))
try {
	const failure = new Error('progress observer failed')
	await Promise.all([
		assert.rejects(throwingProgressPool.run(singleGate, 4, () => { throw failure }), failure),
		assert.rejects(throwingProgressPool.run(singleGate, 4), failure),
	])
} finally { await throwingProgressPool.close() }

const cancellationFixture = new URL('data:text/javascript,' + encodeURIComponent(`
import {parentPort} from 'node:worker_threads';
parentPort.on('message', async ({gates,stopSignal}) => {
 parentPort.postMessage({progress:gates.length});
 const signal=new Int32Array(stopSignal);
 while(!Atomics.load(signal,0)) await new Promise(resolve=>setTimeout(resolve,1));
 parentPort.postMessage({gates});
});`))
const cancellationPool = new WorkerPool(2, cancellationFixture)
cancellationPool.setConcurrency(1)
assert.throws(() => cancellationPool.setConcurrency(3), /concurrency/)
try {
	const signal = new Int32Array(new SharedArrayBuffer(4))
	let secondRan = false
	const active = cancellationPool.run(singleGate, 4, () => { Atomics.store(signal,0,1) }, signal.buffer as SharedArrayBuffer)
	const queued = cancellationPool.run(singleGate, 4, () => { secondRan = true }, signal.buffer as SharedArrayBuffer)
	assert.deepEqual(await Promise.all([active, queued]), [singleGate, singleGate])
	assert.equal(secondRan, false)
} finally { await cancellationPool.close() }
const coalescedDb = new sqlite3.Database(':memory:')
try {
	await runSQL(coalescedDb, 'CREATE TABLE InputOutputReplacers(ioIdentifier BLOB PRIMARY KEY,replacerGates BLOB NOT NULL) WITHOUT ROWID')
	await runSQL(coalescedDb, 'INSERT INTO InputOutputReplacers VALUES(?,?)', [Buffer.from('ff','hex'), Buffer.alloc(0)])
	const nativePrepare = coalescedDb.prepare.bind(coalescedDb)
	let sqlCalls = 0
	coalescedDb.prepare = ((...args: unknown[]) => { sqlCalls++; return (nativePrepare as Function)(...args) }) as typeof coalescedDb.prepare
	const values = await Promise.all([
		getReplacersByIds(coalescedDb, new LimitedMap(10), ['ff']),
		getReplacersByIds(coalescedDb, new LimitedMap(10), ['ff','00']),
		getReplacersByIds(coalescedDb, new LimitedMap(10), ['00']),
	])
	assert.equal(sqlCalls, 1)
	assert.deepEqual(values.map(matches => matches.length), [1,1,0])
} finally { await closeBuild(coalescedDb) }
const bounded = new LimitedMap<string,boolean>(100)
const firstWindow = new WindowFingerprints(singleGate, 256), secondWindow = new WindowFingerprints([{...singleGate[0], gate_i:12}], 256)
firstWindow.remember(bounded,0,1)
secondWindow.remember(bounded,0,1)
assert.equal(secondWindow.seen(bounded,0,1), true)
assert.equal(firstWindow.seen(bounded,0,1), false)
const largeWindowSource = new WindowFingerprints(Array.from({ length: 1024 }, () => singleGate[0]), 256)
largeWindowSource.remember(bounded, 0, 2)
assert.equal(largeWindowSource.seen(bounded, 0, 2), true, 'short keys fit even when the source encoding exceeds the budget')
const entryBounded = new LimitedMap<string, boolean>(2)
for (const window of [firstWindow, secondWindow, firstWindow]) {
	window.remember(entryBounded, 0, 1)
	assert.equal(window.seen(entryBounded, 0, 1), true, 'entry-count evictions release the byte budget')
}
console.log('Out-of-order jobs, cooperative queue cancellation, SQL request sharing and window-cache bounds passed')

// Portfolio routing must use each table's truth-table width and its own cache namespace.
{
const { formatRainbowActivity } = await import('./logging.js')
const specs = [{ wires: 5, gates: 2 }, { wires: 3, gates: 3 }, { wires: 4, gates: 2 }, { wires: 3, gates: 2 }]
const tableDbs = specs.map(spec => ({ ...spec, db: new sqlite3.Database(':memory:') }))
const portfolio = new RainbowPortfolio(tableDbs)
const portfolioCache = new LimitedMap<string, Gate[] | null>(1000)
const not0 = { a: 0, b: 0, target: 0, gate_i: 15 }
const cn = { a: 1, b: 0, target: 0, gate_i: 3 }
const and012 = { a: 0, b: 1, target: 2, gate_i: 1 }
const and234 = { a: 2, b: 3, target: 4, gate_i: 1 }
const putPortfolio = async (wires: number, depth: number, gates: Gate[], stored = gates) => {
	const table = tableDbs.find(table => table.wires === wires && table.gates === depth)!
	await runSQL(table.db, 'INSERT OR REPLACE INTO InputOutputReplacers VALUES (?,?)', [Buffer.from(ioHash(calculateAllOutputsArray(gates, generateCombinations(wires))), 'hex'), encodeGates(stored)])
}
try {
	for (const table of tableDbs) await runSQL(table.db, 'CREATE TABLE InputOutputReplacers(ioIdentifier BLOB PRIMARY KEY,replacerGates BLOB NOT NULL) WITHOUT ROWID')
	await putPortfolio(3, 2, [not0])
	await putPortfolio(3, 3, [cn])
	await putPortfolio(4, 2, [cn])
	const windows = [{ wires: 1, mappedGates: [not0, not0, not0] }, { wires: 2, mappedGates: [cn, cn, cn] }]
	const first = await portfolio.findReplacements(windows, portfolioCache)
	assert.equal(first.get(0)?.table, '3/2')
	assert.equal(first.get(1)?.table, '3/3')
	assert.deepEqual(portfolio.statistics().map(stat => stat.windows), [2, 1, 0, 0])
	assert.deepEqual(await portfolio.findReplacements(windows, portfolioCache), first)
	for (const [index, match] of first) {
		assert.equal(functionKey(match.gates, 5), functionKey(windows[index].mappedGates, 5))
		portfolio.recordApplied(match, windows[index].mappedGates.length)
	}
	assert.deepEqual(portfolio.statistics().map(stat => stat.gatesRemoved), [2, 2, 0, 0])
	const summary = formatRainbowActivity([{ done: false, updatedAtMs: 0, activity: { ...status.activity, rainbowTables: portfolio.statistics() } }])
	assert.match(summary, /3\/2: 2 gates removed, 1 rewrites/)
	assert.match(summary, /lookup worker-seconds/)
	// A miss in both three-wire tables can still match after widening to four wires.
	await putPortfolio(4, 2, [cn, and012])
	const wider = await portfolio.findReplacements([{ wires: 3, mappedGates: [cn, and012, not0, not0] }], portfolioCache)
	assert.equal(wider.get(0)?.table, '4/2')
	// Five-wire windows bypass all smaller tables, and an exact-size window is scanned.
	await putPortfolio(5, 2, [and012, and234])
	portfolio.resetStatistics()
	const fiveWindow = [and012, and234, not0, not0]
	const result = await massOptimizeStep(portfolio, portfolioCache, new LimitedMap(100), fiveWindow, 4, false, false)
	assert.deepEqual(result.gates, [and012, and234])
	assert.equal(functionKey(result.gates, 5), functionKey(fiveWindow, 5))
	assert.deepEqual(portfolio.statistics().map(stat => stat.windows), [0, 0, 0, 1])
	assert.equal(portfolio.statistics()[3].gatesRemoved, 2)
	assert.equal((await portfolio.findReplacements([{ wires: 6, mappedGates: fiveWindow }], portfolioCache)).size, 0)
	// Non-improving hits and hits borrowing absent wires must allow fallback.
	await putPortfolio(3, 2, [], [not0, not0])
	await putPortfolio(3, 3, [])
	const identityWindow = { wires: 1, mappedGates: [not0, not0] }
	assert.equal((await portfolio.findReplacements([identityWindow], new LimitedMap(100))).get(0)?.table, '3/3')
	const not2 = { ...not0, target: 2 }
	await putPortfolio(3, 2, [], [not2, not2])
	assert.equal((await portfolio.findReplacements([{ wires: 1, mappedGates: [not0, not0, not0, not0] }], new LimitedMap(100))).get(0)?.table, '3/3')
	// The same raw ID can be a miss in one table and a hit in another at the same width.
	const shared = new LimitedMap<string, Gate[] | null>(100)
	const cnKey = ioHash(calculateAllOutputsArray([cn], generateCombinations(3)))
	assert.deepEqual(await getReplacersByIds(tableDbs[3].db, shared, [cnKey], '3/2:'), [])
	assert.equal((await getReplacersByIds(tableDbs[1].db, shared, [cnKey], '3/3:')).length, 1)
} finally { await portfolio.close() }
for (const tables of [[], null, {}, [null], [1], [{ wires: 0, gates: 1 }], [{ wires: 9, gates: 1 }], [{ wires: 3, gates: 0 }], [{ wires: 3.5, gates: 2 }], [{ wires: 3, gates: 2.5 }], [{ wires: '3', gates: 2 }], [{ wires: 3 }], [{ wires: 3, gates: 2, typo: true }], [{ wires: 3, gates: 2 }, { wires: 3, gates: 2 }]]) {
	assert.throws(() => parseConfig({ database: { tables } }))
}
const tableSettings = [{ wires: 2, gates: 2 }, { wires: 2, gates: 3 }]
const parsedTables = parseConfig({ database: { tables: tableSettings } })
tableSettings[0].gates = 99
assert.equal(parsedTables.database.tables[0].gates, 2)
assert.throws(() => parseConfig({ database: { tables: [{ wires: 8, gates: 1 }] }, validation: { maximumWires: 7 } }))
console.log('Rainbow portfolio routing, fallback, cache isolation, contribution and configuration regressions passed')
}

// The startup lifecycle generates every missing table and reuses complete files.
{
	const { initializeRainbowTables, openRainbowPortfolio } = await import('./rainbow-portfolio.js')
	const { databaseFilename } = await import('./rainbowtable.js')
	const directory = await mkdtemp(join(tmpdir(), 'deobfuscator-portfolio-'))
	const tables = [{ wires: 2, gates: 1 }, { wires: 2, gates: 2 }]
	try {
		process.chdir(directory)
		await initializeRainbowTables(tables)
		const snapshots = tables.map(table => readFileSync(databaseFilename(table.wires, table.gates)))
		await initializeRainbowTables(tables)
		for (const [i, table] of tables.entries()) assert.deepEqual(readFileSync(databaseFilename(table.wires, table.gates)), snapshots[i])
		const opened = await openRainbowPortfolio(tables)
		try {
			const cn = { a: 1, b: 0, target: 0, gate_i: 3 }
			const result = await opened.findReplacements([{ wires: 2, mappedGates: [cn, cn, cn] }], new LimitedMap(100))
			assert.equal(result.get(0)?.table, '2/1')
			assert.equal(functionKey(result.get(0)!.gates, 2), functionKey([cn], 2))
		} finally { await opened.close() }
	} finally {
		process.chdir(originalCwd)
		await rm(directory, { recursive: true, force: true })
	}
}
console.log('Multi-table generation, reuse and connection lifecycle regressions passed')
await import('./generation-test.js')
await import('./search-reuse-test.js')
await import('./work-elimination-test.js')
await import('./resource-search-test.js')
await import('./benchmark-regression-test.js')
await import('./generation-benchmark-test.js')
await import('./generation-finalize-test.js')
await import('./generation-dedup-test.js')
await import('./generation-staging-test.js')
await import('./staging-benchmark-test.js')
await import('./generation-merge-test.js')
await import('./generation-diagnostics-test.js')
await import('./generation-prefetch-test.js')

await import('./generation-shards-test.js')

await import('./generation-interval-test.js')

await import('./generation-final-lookup-test.js')

await import('./generation-streaming-test.js')

await import('./round-search-test.js')

await import('./affine-test.js')

await import('./symbolic-affine-test.js')

await import('./strategy-summary-test.js')

await import('./strategy-picker-test.js')

await import('./broad-search-test.js')

await import('./polynomial-synthesis-test.js')

await import('./coordinator-status-test.js')

await import('./adaptive-strategy-test.js')

await import('./probabilistic-rewrite-test.js')

await import('./structural-strategies-test.js')

await import('./worker-utilization-test.js')

await import('./run-lifecycle-test.js')

await import('./memory-concurrency-test.js')

await import('./dependency-cuts-test.js')

await import('./checkpoint-progress-test.js')

await import('./local-global-scheduling-test.js')

await import('./dependency-deadline-test.js')

await import('./worker-heartbeat-test.js')

await import('./local-publication-test.js')

await import('./checkpoint-coalescing-test.js')

await import('./profile-optimizations-test.js')
