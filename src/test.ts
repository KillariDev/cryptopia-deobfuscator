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
const { calculateAllOutputsArray, evalCircuit, generateCombinations, getVars } = await import('./utils.js')
const { createDependencyGraph } = await import('./lineswapper.js')
const { shuffleRowsWithDependentGateSwap, optimize, createOptimizerCaches } = await import('./processing.js')
const { LimitedMap } = await import('./limitedMap.js')
const { getReplacersByIds, isEmpty } = await import('./rainbowtable.js')
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
await sql('CREATE TABLE InputOutputReplacers (ioIdentifier TEXT PRIMARY KEY, replacerGates TEXT NOT NULL)')
assert.equal(await isEmpty(db), true)
await sql("INSERT INTO InputOutputReplacers VALUES ('identity', '')")
assert.equal(await isEmpty(db), false)
const cache = new LimitedMap<string, Gate[] | null>(100)
assert.deepEqual(await getReplacersByIds(db, cache, ['missing', 'missing', 'identity']), [{ ioIdentifier: 'identity', gates: [] }])
assert.equal(cache.get('missing'), null)
const optimizerCaches = createOptimizerCaches()
const singleGate = [{ a: 0, b: 0, target: 1, gate_i: 3 }]
for (let round = 0; round < 2; round++) {
	const result = await optimize(db, singleGate, 4, 'test', true, 4, optimizerCaches, 1)
	assert.deepEqual(calculateAllOutputsArray(result!, generateCombinations(4)), calculateAllOutputsArray(singleGate, generateCombinations(4)))
}
assert.deepEqual(await optimize(db, [], 4, 'test', true, 4, optimizerCaches, 1), [])
await new Promise<void>((resolve, reject) => db.close(error => error ? reject(error) : resolve()))
// A cached miss and hit must work even after the database is closed.
assert.deepEqual(await getReplacersByIds(db, cache, ['missing', 'identity']), [{ ioIdentifier: 'identity', gates: [] }])
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
	const paths = outputPaths('custom/task')
	prepareOutputDirectories()
	assert.ok(existsSync('data/worker'))
	assert.ok(existsSync('data/progress'))
	writeCircuit('original.json', 4, singleGate)
	const initialJob = loadJob('data/latest', 'original')
	assert.match(describeJob('data/latest', 'original', initialJob), /start from original circuit/)
	for (const filename of [paths.latest, paths.progress(1), paths.worker(0)]) {
		writeCircuit(filename, 4, singleGate)
		assert.equal(JSON.parse(readFileSync(filename, 'utf8')).gates.length, 1)
	}
	const summary = describeJob('data/latest', 'original', loadJob('data/latest', 'original'))
	assert.match(summary, /resume saved circuit/)
	assert.match(summary, /1 gates, 4 wires/)
	assert.ok(summary.includes(join(temporaryDirectory, 'data', 'worker')))
	assert.ok(summary.includes(join(temporaryDirectory, 'data', 'progress')))
	assert.ok(summary.includes(join(temporaryDirectory, 'data', 'latest.json')))
	assert.match(summary, /Worker limit:/)
	assert.match(summary, /25 minutes/)
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
	delete process.env.OPTIMIZER_VERBOSE
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

const { formatWorkerActivity, shouldFinishReducedRound } = await import('./logging.js')
const status = { activity: { passes: 3, subsets: 120, checks: 900, improvements: 4, stage: 'searching' as const }, updatedAtMs: 5_000, done: false }
const detail = formatWorkerActivity([status, { updatedAtMs: 0, done: true }], 10_000, 25 * 60_000)
assert.match(detail, /3 passes, 120 subsets visited, 900 optimization checks, 4 improving rewrites/)
assert.match(detail, /1 searching/)
assert.match(detail, /1 completed/)
assert.match(detail, /5s ago/)
assert.equal(shouldFinishReducedRound(299_999, 100, 99), false)
assert.equal(shouldFinishReducedRound(300_000, 100, 99), true)
assert.equal(shouldFinishReducedRound(600_000, 100, 100), false)
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
	Atomics.store(signal, 0, 1)
	const activities: string[] = []
	const result = await stoppedPool.run(singleGate, 4, (_, activity) => { if (activity) activities.push(activity.stage) }, signal.buffer as SharedArrayBuffer)
	assert.deepEqual(result, singleGate)
	assert.ok(activities.includes('searching'))
	assert.ok(activities.includes('verifying'))
} finally {
	await stoppedPool.close()
	process.chdir(originalCwd)
	await rm(stopDirectory, { recursive: true, force: true })
}
console.log('Detailed progress, reduction checkpoints and round-stop regressions passed')

const { defaults, parseConfig, config } = await import('./config.js')
assert.deepEqual(parseConfig({}), defaults)
assert.deepEqual(parseConfig(JSON.parse(readFileSync(new URL('../solver.config.json', import.meta.url), 'utf8'))), defaults)
const custom = parseConfig({ timing: { summarySeconds: 10, improvedRoundMinutes: 2 }, workers: { maximum: 3 }, logging: { verbose: true } })
assert.equal(custom.timing.summarySeconds, 10)
assert.equal(custom.workers.maximum, 3)
assert.equal(custom.database.wires, 4)
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
	assert.equal(result.path, join('custom-data', 'latest.json'))
	assert.equal(result.finish, true)
	const launch = spawnSync(process.execPath, [fileURLToPath(new URL('./launch.js', import.meta.url)), 'only-one-argument'], { encoding: 'utf8' })
	assert.equal(launch.status, 1)
	assert.match(launch.stderr, /Usage:/)
	const missingInputs = spawnSync(process.execPath, [fileURLToPath(new URL('./launch.js', import.meta.url))], { encoding: 'utf8' })
	assert.equal(missingInputs.status, 1)
	assert.match(missingInputs.stderr, /Usage:/)
} finally { await rm(configDir, { recursive: true, force: true }) }

const { IncrementalEvaluator } = await import('./packed.js')
const { RewriteCache, normalizeWindow, SearchScheduler, balancedChunks, improving } = await import('./search.js')
const { isReplacementSimpler, findConvexSubsets } = await import('./utils.js')
for (const wires of [1, 4, 8]) {
	const combinations = generateCombinations(wires)
	for (const count of [0, 1, 17, 32, 33, 64, 202]) {
		const inputs = Array.from({ length: count }, (_, i) => combinations[i % combinations.length])
		const reference = makeGates(45, wires)
		for (const bytes of [0, 64, 8192]) {
			const evaluator = new IncrementalEvaluator(reference, inputs, bytes, 4)
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
const arms = [{ subset: 3, slice: 2, method: 'all' as const }, { subset: 5, slice: 3, method: 'rainbow' as const }]
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
} finally { Math.random = savedRandom }
console.log('Adaptive, incremental, packed, normalized-cache, pruning and balancing regressions passed')

// Exercise the actual rewrite and subset-search paths with a tiny SQLite table.
const { massOptimizeStep, optimizeSubset } = await import('./processing.js')
const { ioHash } = await import('./utils.js')
const integrationDb = new sqlite3.Database(':memory:')
const runSql = (sql: string, params: unknown[] = []) => new Promise<void>((resolve, reject) => integrationDb.run(sql, params, error => error ? reject(error) : resolve()))
try {
	await runSql('CREATE TABLE InputOutputReplacers (ioIdentifier TEXT PRIMARY KEY, replacerGates TEXT NOT NULL)')
	const inputs = generateCombinations(4)
	await runSql('INSERT INTO InputOutputReplacers VALUES (?, ?)', [ioHash(inputs.flat()), ''])
	const cnot = { a: 1, b: 0, target: 0, gate_i: 3 }
	const circuit = Array.from({ length: 8 }, () => ({ ...cnot }))
	const result = await massOptimizeStep(integrationDb, new LimitedMap(100), new LimitedMap(100), circuit, 2, false, false, 4, inputs)
	assert.ok(result.gates.length < circuit.length)
	assert.deepEqual(inputs.map(input => evalCircuit(result.gates, input)), inputs.map(input => evalCircuit(circuit, input)))
	for (const offset of [0, 4]) {
		const identity = Array.from({ length: 6 }, (_, i) => ({ a: 0, b: 0, target: offset + i % 2, gate_i: 0 }))
		const exact = await massOptimizeStep(integrationDb, new LimitedMap(100), new LimitedMap(100), identity, 3, false, true, 4, inputs, false)
		assert.ok(exact.gates.length < identity.length)
		assert.deepEqual(generateCombinations(6).map(input => evalCircuit(exact.gates, input)), generateCombinations(6).map(input => evalCircuit(identity, input)))
	}
	await runSql('DELETE FROM InputOutputReplacers')
	const tested = new LimitedMap<string, boolean>(1000)
	const processed = new LimitedMap<string, boolean>(1000)
	const lookups = new LimitedMap<string, Gate[] | null>(1000)
	const counters = () => ({ passes: 0, subsets: 0, checks: 0, improvements: 0, stage: 'searching' as const })
	const first = counters(), second = counters()
	const unchanged = circuit.map((gate, i) => ({ ...gate, a: i % 2, target: 1 - i % 2 }))
	await optimizeSubset(integrationDb, unchanged, lookups, processed, 3, 2, 'heavy', () => false, 4, inputs, first, () => {}, tested, 'rainbow')
	await optimizeSubset(integrationDb, unchanged, lookups, processed, 3, 2, 'heavy', () => false, 4, inputs, second, () => {}, tested, 'rainbow')
	assert.ok(first.checks > 0)
	assert.equal(second.checks, 0)
} finally { await new Promise<void>((resolve, reject) => integrationDb.close(error => error ? reject(error) : resolve())) }
console.log('Solver integration regressions passed')

const { formatStatus } = await import('./logging.js')
const compact = formatStatus({ original: 1000, roundStart: 200, candidate: 100, saved: 100, statuses: [status, { updatedAtMs: 0, done: true }], elapsedMs: 60_000 })
assert.match(compact, /90.00% fewer than original; 100 removed this round/)
assert.match(compact, /Checkpoint up to date/)
assert.match(compact, /1 worker active/)
assert.match(compact, /20% elapsed/)
assert.ok(!compact.includes('oldest'))
assert.ok(!compact.includes('subsets'))
const completedStatus = formatStatus({ original: 100, roundStart: 100, candidate: 50, statuses: [{ updatedAtMs: 0, done: true }], elapsedMs: 300_000 })
assert.match(completedStatus, /All workers finished/)
assert.match(completedStatus, /Round finished in 5m 0s/)
assert.ok(!completedStatus.includes('% elapsed'))
assert.match(completedStatus, /No checkpoint saved this run yet/)
const lateStatus = formatStatus({ original: 100, roundStart: 100, candidate: 100, saved: 100, statuses: [status], elapsedMs: 90_000 })
assert.match(lateStatus, /Warning: 1 worker update delayed/)
assert.match(lateStatus, /6% elapsed/)
assert.ok(!formatStatus({ original: 0, roundStart: 0, candidate: 0, statuses: [], elapsedMs: 0 }).includes('NaN'))

const { TemplateLibrary } = await import('./templates.js')
const { functionKey, circuitState, semanticCircuits, meetInMiddle, encodeGates, decodeGates, truthKey } = await import('./semantic.js')
const { saturateCircuit, CircuitEqualityGraph } = await import('./equality.js')
const library = new TemplateLibrary(100, 4)
for (let f = 0; f < 16; f++) for (let h = 0; h < 16; h++) {
	const gates = [{ a: 0, b: 1, target: 2, gate_i: f }, { a: 1, b: 0, target: 2, gate_i: h }]
	const rewritten = library.rewrite(gates)
	assert.equal(functionKey(gates, 3), functionKey(rewritten, 3))
	assert.ok(rewritten.length < gates.length)
	assert.deepEqual(decodeGates(encodeGates(gates)), gates)
}
const unsafe = [{ a: 0, b: 1, target: 0, gate_i: 3 }, { a: 0, b: 1, target: 0, gate_i: 3 }]
assert.equal(functionKey(library.rewrite(unsafe), 2), functionKey(unsafe, 2))
assert.equal(library.learn(singleGate, []), false)
const not0 = { a: 0, b: 0, target: 0, gate_i: 15 }, not1 = { a: 0, b: 0, target: 1, gate_i: 15 }
const separated = [not0, not1, not0]
const saturated = saturateCircuit(separated, 2, library, 100, 500)
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
const { synthesizeSMT } = await import('./smt.js')
const smtResult = await synthesizeSMT([singleGate[0], singleGate[0], singleGate[0]], 2, 1, 5000)
assert.ok(smtResult && smtResult.length <= 1)
assert.equal(functionKey(smtResult!, 2), functionKey(singleGate, 2))
console.log('Template, semantic generation, meet-in-the-middle, equality graph and SMT regressions passed')

const { migrateDatabase } = await import('./migrate.js')
const dbDirectory = await mkdtemp(join(tmpdir(), 'deobfuscator-migration-'))
const sourcePath = join(dbDirectory, 'legacy.db'), destinationPath = join(dbDirectory, 'compact.db')
const legacy = new sqlite3.Database(sourcePath)
const legacyRun = (sql: string, params: unknown[] = []) => new Promise<void>((resolve, reject) => legacy.run(sql, params, error => error ? reject(error) : resolve()))
try {
	await legacyRun('CREATE TABLE InputOutputReplacers (ioIdentifier TEXT PRIMARY KEY, replacerGates TEXT NOT NULL)')
	const { hashBooleanArrays } = await import('./utils.js')
	const inputs = generateCombinations(2)
	for (const gates of [[], [not0], [singleGate[0]]]) await legacyRun('INSERT INTO InputOutputReplacers VALUES (?, ?)', [hashBooleanArrays(inputs.flatMap(input => evalCircuit(gates, input))), encodeGates(gates).toString('latin1')])
	await new Promise<void>((resolve, reject) => legacy.close(error => error ? reject(error) : resolve()))
	const originalBytes = readFileSync(sourcePath)
	assert.equal(await migrateDatabase(sourcePath, destinationPath, 2, 2), 3)
	assert.deepEqual(readFileSync(sourcePath), originalBytes)
	await assert.rejects(migrateDatabase(sourcePath, destinationPath, 2, 2), /new destination/)
	const compactDb = new sqlite3.Database(destinationPath)
	try {
		const rows = await new Promise<any[]>((resolve, reject) => compactDb.all('SELECT * FROM InputOutputReplacers', (error, rows) => error ? reject(error) : resolve(rows)))
		assert.equal(rows.length, 3)
		for (const row of rows) {
			assert.ok(Buffer.isBuffer(row.ioIdentifier) && Buffer.isBuffer(row.replacerGates))
			assert.deepEqual(row.ioIdentifier, truthKey(inputs.flatMap(input => evalCircuit(decodeGates(row.replacerGates), input))))
		}
	} finally { await new Promise<void>(resolve => compactDb.close(() => resolve())) }
	await assert.rejects(migrateDatabase(sourcePath, join(dbDirectory, 'wrong-wires.db'), 3, 2), /Invalid legacy entry/)
	assert.equal(existsSync(join(dbDirectory, 'wrong-wires.db')), false)
	assert.equal(existsSync(join(dbDirectory, 'wrong-wires.db.building')), false)
	const configPath = join(dbDirectory, 'settings.json')
	const { writeFileSync } = await import('node:fs')
	writeFileSync(configPath, JSON.stringify({ files: { databaseDirectory: dbDirectory }, database: { format: 'compact', wires: 2, gates: 2, semanticGeneration: true, generationStates: 10000, memoryMapBytes: 4096 }, synthesis: { meetInMiddle: true, attemptEvery: 1 } }))
	const script = `
		import {createRainbowTable,getReplacersByIds} from ${JSON.stringify(new URL('./rainbowtable.js', import.meta.url).href)};
		import {generateCombinations,ioHash} from ${JSON.stringify(new URL('./utils.js', import.meta.url).href)};
		import {LimitedMap} from ${JSON.stringify(new URL('./limitedMap.js', import.meta.url).href)};
		import {advancedRewrite} from ${JSON.stringify(new URL('./strategies.js', import.meta.url).href)};
		const db=await createRainbowTable(2,2);
		const matches=await getReplacersByIds(db,new LimitedMap(10),[ioHash(generateCombinations(2).flat())]);
		if(matches.length!==1 || matches[0].gates.length!==0) throw Error('Compact lookup failed');
		const not={a:0,b:0,target:0,gate_i:15};
		const replacement=await advancedRewrite([not,not,not]);
		if(!replacement || replacement.length!==1) throw Error('Integrated synthesis failed');
		await new Promise((resolve,reject)=>db.close(error=>error?reject(error):resolve()));
	`
	execFileSync(process.execPath, ['--input-type=module', '-e', script], { env: { ...process.env, OPTIMIZER_CONFIG: configPath }, timeout: 15000 })
} finally { await rm(dbDirectory, { recursive: true, force: true }) }
console.log('Compact storage, migration, memory-map readiness and synthesis integration regressions passed')

assert.equal(parseConfig({ database: { memoryMapBytes: 0 } }).database.memoryMapBytes, 0)
assert.throws(() => parseConfig({ database: { format: 'unknown' } }))
assert.throws(() => parseConfig({ synthesis: { maximumWires: 5 } }))

const { canonicalCircuits } = await import('./semantic.js')
const { sequenceSpace, progressPercent, generationETA, formatGenerationProgress } = await import('./generation-progress.js')
assert.equal(sequenceSpace(172, 5)[5], 1n + 172n + 172n ** 2n + 172n ** 3n + 172n ** 4n + 172n ** 5n)
assert.equal(progressPercent(1n, 1000000n), '<0.01%')
assert.equal(progressPercent(1n, 2n), '50.00%')
assert.equal(progressPercent(2n, 2n), '100.00%')
assert.match(generationETA(25n, 100n, 10000), /30s/)
assert.match(generationETA(0n, 100n, 10000), /learning/)
let finalProgress: import('./generation-progress.js').SequenceProgress | undefined
const canonical = [...canonicalCircuits(catalog, 3, value => { finalProgress = value })]
const expectedCanonical = brute.filter(gates => [...new Set(gates.flatMap(getVars))].every((wire, index) => wire === index))
const structuralKey = (gates: Gate[]) => JSON.stringify(gates)
assert.deepEqual(canonical.map(structuralKey).sort(), expectedCanonical.map(structuralKey).sort())
assert.equal(finalProgress!.covered, finalProgress!.total)
assert.equal(finalProgress!.evaluated, canonical.length)
assert.ok(finalProgress!.pruned > 0n)
assert.equal(BigInt(finalProgress!.evaluated) + finalProgress!.pruned, finalProgress!.total)
assert.ok(finalProgress!.examined < brute.length)
const generationLine = formatGenerationProgress({ covered: 50n, total: 100n, examined: 30, evaluated: 25, pruned: 25n }, undefined, 10, 10000, false)
assert.match(generationLine, /50.00%/)
assert.match(generationLine, /search ETA ~10s/)
assert.match(generationLine, /10 functions buffered/)
assert.match(formatGenerationProgress(undefined, { depth: 2, processed: 10, total: 20, states: 4 }, 4, 5000, false), /layer 50.00%.*layer ETA ~5s.*overall ETA unavailable/)
assert.match(formatGenerationProgress(finalProgress, undefined, 10, 10000, true), /writing database; write ETA unavailable/)
console.log('Rainbow progress, ETA and canonical-prefix pruning regressions passed')
