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
 parentPort.postMessage({gates: [...gates, {a: ++calls, b: 0, target: 0, gate_i: 0}]});
});`))
const pool = new WorkerPool(1, fixture)
try {
	const results = await Promise.all([pool.run([], 1), pool.run([], 1), pool.run([], 1)])
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
console.log('Performance and correctness regressions passed')
