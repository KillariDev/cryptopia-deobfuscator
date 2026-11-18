import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import sqlite3 from 'sqlite3'
import { ChunkedSequence } from './chunked-sequence.js'
import { patchCircuit, LazyCircuit } from './circuit-edit.js'
import { IncrementalGraph } from './incremental-graph.js'
import { WindowFingerprints } from './fingerprints.js'
import { selectIntervals, WeightedInterval } from './intervals.js'
import { LookupStatements } from './lookup-statements.js'
import { SubsetPreparation, massOptimizeStep, optimizeSubset } from './processing.js'
import { templates } from './strategies.js'
import { RainbowPortfolio, initializeRainbowTables, openRainbowPortfolio } from './rainbow-portfolio.js'
import { databaseFilename, hasCanonicalCoverage, closeRainbowTable, getReplacersByIds } from './rainbowtable.js'
import { encodeGates, functionKey } from './semantic.js'
import { config, parseConfig } from './config.js'
import { Gate } from './types.js'
import { LimitedMap } from './limitedMap.js'
import { allSQL, runSQL } from './sql.js'
import { createDependencyGraph } from './lineswapper.js'
import { calculateAllOutputsArray, generateCombinations, dependencyGraphToMap, dependencySort, getVars } from './utils.js'

let seed = 6297
const random = (n: number) => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return (seed >>> 8) % n }
let nextId = 100000
for (const chunkSize of [1, 3, 16, 128]) {
	let values = Array.from({ length: 400 }, (_, i) => i)
	const sequence = new ChunkedSequence(values, chunkSize, true)
	for (let edit = 0; edit < 70 && values.length; edit++) {
		const selected = [...new Set(Array.from({ length: 1 + random(9) }, () => random(values.length)))].reverse()
		const replacement = Array.from({ length: random(5) }, () => nextId++)
		const expected = patchCircuit(values, selected, replacement)
		const old = sequence.toArray()
		assert.equal(sequence.replace(selected, replacement), expected.start)
		values = expected.values
		assert.deepEqual(sequence.toArray(), values)
		assert.notEqual(sequence.toArray(), old)
		assert.deepEqual([...sequence], values)
		for (const [i, value] of values.entries()) { assert.equal(sequence.at(i), value); assert.equal(sequence.indexOf(value), i) }
	}
	sequence.replace(Array.from({ length: sequence.length }, (_, i) => i), [])
	assert.equal(sequence.length, 0)
	assert.deepEqual(sequence.toArray(), [])
}
assert.throws(() => new ChunkedSequence([1, 1], 4, true))
const consecutive = ChunkedSequence.consecutiveIds(12, 4)
assert.equal(consecutive.indexOf(8), 8)
consecutive.replace([0, 5], [20])
assert.equal(consecutive.indexOf(0), undefined)
assert.equal(consecutive.indexOf(5), undefined)
assert.equal(consecutive.indexOf(20), 4)
assert.equal(consecutive.indexOf(8), 7)
assert.throws(() => consecutive.replace([0], [8]), /Duplicate stable circuit ID/)
consecutive.replace([0], [5])
assert.equal(consecutive.indexOf(5), 0)
assert.equal(consecutive.indexOf(1), undefined)
const duplicateGates = new ChunkedSequence([1, 1, 1], 2)
duplicateGates.replace([0, 2], [2, 2]); assert.deepEqual(duplicateGates.toArray(), [1, 2, 2])
const lazyPart = new ChunkedSequence([1, 2, 3].map(target => ({ a: 0, b: 0, target, gate_i: 15 })), 1)
const lazy = new LazyCircuit([lazyPart])
lazyPart.replace([1], []); lazy.update(0, lazyPart)
assert.equal(lazy.length, 2); assert.deepEqual(lazy.materialize(), lazyPart.toArray())
lazyPart.replace([0], []); lazy.update(0, lazyPart)
assert.equal(lazy.length, 1); assert.deepEqual(lazy.materialize(), lazyPart.toArray())

for (let trial = 0; trial < 4; trial++) {
	let gates = Array.from({ length: 320 }, () => ({ a: random(8), b: random(8), target: random(8), gate_i: random(16) }))
	const graph = new IncrementalGraph(gates, 8)
	const searchGraph = new IncrementalGraph(gates, 8, { trackFuture: false })
	for (let edit = 0; edit < 35; edit++) {
		const selected = [...new Set(Array.from({ length: 4 }, () => random(gates.length)))].sort((a, b) => a - b)
		const replacement = Array.from({ length: random(4) }, () => ({ a: random(8), b: random(8), target: random(8), gate_i: random(16) }))
		graph.replace(selected, replacement)
		searchGraph.replace(selected, replacement)
		gates = patchCircuit(gates, selected, replacement).values
		const nodes = createDependencyGraph(gates)
		assert.deepEqual(graph.context().nodes, nodes)
		assert.deepEqual(graph.context().dependantMap, dependencyGraphToMap(nodes))
		const search = searchGraph.context()
		assert.deepEqual(search.nodes, nodes.map(node => ({ ...node, dependOnFutureLine: -1 })))
		assert.deepEqual(search.access, graph.context().access)
		assert.deepEqual(search.dependantMap, graph.context().dependantMap)
		for (const size of [2, 8, 24]) {
			const anchor = random(gates.length)
			assert.deepEqual(searchGraph.selectRegion(anchor, size), dependencySort(search.dependantMap, nodes[anchor], size, nodes, gates, search.access))
		}
	}
}

const score = (items: WeightedInterval[]) => items.reduce((sum, item) => [sum[0] + item.removed, sum[1] + item.wireSavings, sum[2] + item.readSavings], [0, 0, 0])
const greater = (a: number[], b: number[]) => a[0] !== b[0] ? a[0] > b[0] : a[1] !== b[1] ? a[1] > b[1] : a[2] > b[2]
for (let trial = 0; trial < 70; trial++) {
	const input = Array.from({ length: 8 }, () => { const start = random(12); return { start, end: start + 1 + random(5), removed: random(5), wireSavings: random(3) - 1, readSavings: random(5) - 1 } })
	let best = [0, 0, 0]
	for (let mask = 0; mask < 1 << input.length; mask++) {
		const selected = input.filter((_, i) => mask & 1 << i).sort((a, b) => a.start - b.start)
		if (selected.some((item, i) => i && selected[i - 1].end > item.start)) continue
		const candidate = score(selected); if (greater(candidate, best)) best = candidate
	}
	const selected = selectIntervals(input)
	assert.deepEqual(score(selected), best)
	assert.ok(selected.every((item, i) => !i || selected[i - 1].end <= item.start))
}
assert.deepEqual(selectIntervals([{ start: 0, end: 4, removed: 1, wireSavings: 0, readSavings: 0 }, { start: 1, end: 5, removed: 3, wireSavings: 0, readSavings: 0 }]).map(i => i.start), [1])

const n0 = { a: 0, b: 0, target: 0, gate_i: 15 }
// A borrowed-wire hit cannot prove that a later table lacks a permitted winner.
const borrowedDbs = [new sqlite3.Database(':memory:'), new sqlite3.Database(':memory:')]
const borrowedPortfolio = new RainbowPortfolio(borrowedDbs.map((db, i) => ({ db, wires: 3 + i, gates: 2 - i, canonicalCoverage: true })))
try {
	for (const db of borrowedDbs) await runSQL(db, 'CREATE TABLE InputOutputReplacers(ioIdentifier BLOB PRIMARY KEY,replacerGates BLOB NOT NULL)')
	await runSQL(borrowedDbs[0], 'INSERT INTO InputOutputReplacers VALUES (?,?)', [Buffer.from(functionKey([], 3), 'hex'), encodeGates([{ ...n0, target: 2 }, { ...n0, target: 2 }])])
	await runSQL(borrowedDbs[1], 'INSERT INTO InputOutputReplacers VALUES (?,?)', [Buffer.from(functionKey([], 4), 'hex'), Buffer.alloc(0)])
	const result = await borrowedPortfolio.findReplacements([{ wires: 1, mappedGates: [n0, n0] }], new LimitedMap(100))
	assert.equal(result.get(0)?.table, '4/1')
} finally { await borrowedPortfolio.close() }
const fingerprints = new WindowFingerprints([n0, { ...n0, target: 1 }, n0])
const expectedBinary = [n0, { ...n0, target: 1 }].map(g => String.fromCharCode(g.a, g.b, g.target, g.gate_i)).join('')
assert.equal(fingerprints.exactKey(0, 2), `${fingerprints.key(0, 2)}:binary:${expectedBinary}`)
const unusual = [{ ...n0, target: 70000 }]
assert.match(new WindowFingerprints(unusual).exactKey(0, 1), /:text:/)

const db = new sqlite3.Database(':memory:')
const statements = new LookupStatements(db, 2)
try {
	await assert.rejects(statements.query([Buffer.from('00', 'hex')]), /no such table/)
	await runSQL(db, 'CREATE TABLE InputOutputReplacers(ioIdentifier BLOB PRIMARY KEY,replacerGates BLOB NOT NULL)')
	for (const id of ['00', '01', '02']) await runSQL(db, 'INSERT INTO InputOutputReplacers VALUES (?,?)', [Buffer.from(id, 'hex'), Buffer.alloc(0)])
	const nativePrepare = db.prepare.bind(db)
	let prepares = 0
	db.prepare = ((...args: unknown[]) => { prepares++; return (nativePrepare as Function)(...args) }) as typeof db.prepare
	const queries = await Promise.all(['00', '01', '02'].map(id => statements.query<{ ioIdentifier: Buffer }>([Buffer.from(id, 'hex')])))
	assert.deepEqual(queries.map(rows => rows[0].ioIdentifier.toString('hex')), ['00', '01', '02'])
	assert.equal(prepares, 1)
	await statements.query([Buffer.from('00', 'hex'), Buffer.from('01', 'hex')])
	await statements.query([Buffer.from('00', 'hex'), Buffer.from('01', 'hex'), Buffer.from('02', 'hex')])
	await statements.query([Buffer.from('02', 'hex')])
	assert.equal(prepares, 4, 'LRU evicts unused batch shapes')
	await runSQL(db, 'DROP TABLE InputOutputReplacers')
	await assert.rejects(statements.query([Buffer.from('00', 'hex')]), /no such table/)
	await runSQL(db, 'CREATE TABLE InputOutputReplacers(ioIdentifier BLOB PRIMARY KEY,replacerGates BLOB NOT NULL)')
	await statements.query([Buffer.from('00', 'hex')])
	const pending = statements.query([Buffer.from('01', 'hex')]), closing = statements.close()
	await pending; await closing
	await assert.rejects(statements.query([Buffer.from('00', 'hex')]), /closed/)
} finally { await statements.close(); await new Promise<void>((resolve, reject) => db.close(error => error ? reject(error) : resolve())) }

const pendingDb = new sqlite3.Database(':memory:')
await runSQL(pendingDb, 'CREATE TABLE InputOutputReplacers(ioIdentifier BLOB PRIMARY KEY,replacerGates BLOB NOT NULL)')
const outstanding = getReplacersByIds(pendingDb, new LimitedMap(10), ['00'])
const closed = closeRainbowTable(pendingDb)
assert.deepEqual(await outstanding, [])
await closed

const memory = new sqlite3.Database(':memory:')
const portfolio = new RainbowPortfolio([{ db: memory, wires: 3, gates: 1 }])
const originalRewrite = templates.rewrite.bind(templates)
let scans = 0
try {
	await runSQL(memory, 'CREATE TABLE InputOutputReplacers(ioIdentifier BLOB PRIMARY KEY,replacerGates BLOB NOT NULL)')
	assert.equal(await hasCanonicalCoverage(memory, 3, 1), false)
	templates.rewrite = gates => { scans++; return originalRewrite(gates) }
	const gates = Array.from({ length: 4 }, (_, i) => ({ a: (i + 1) % 4, b: 0, target: i, gate_i: 3 }))
	const preparation = new SubsetPreparation(gates)
	assert.equal(preparation.fingerprint(gates), preparation.fingerprint(gates))
	for (const size of [2, 3, 4]) await massOptimizeStep(portfolio, new LimitedMap(100), new LimitedMap(100), gates, size, false, false, true, preparation)
	assert.equal(scans, 1, 'unchanged subsets scan templates once across sizes')
	templates.rewrite = originalRewrite
	const sliceActivity = { passes: 0, subsets: 0, checks: 0, improvements: 0, stage: 'searching' as const }
	assert.deepEqual(await optimizeSubset(portfolio, gates, new LimitedMap(100), new LimitedMap(100), 3, 199, 'heavy', () => false, sliceActivity, () => {}, new LimitedMap(100), 'rainbow'), gates)
	assert.ok(sliceActivity.subsets > 0)
	assert.equal(sliceActivity.checks, sliceActivity.subsets * 2, 'only sizes 2 and 3 run, once each')
	templates.rewrite = gates => { scans++; return originalRewrite(gates) }
	const version = templates.version
	const before = [n0, { ...n0, target: 1 }, n0, { ...n0, target: 1 }, n0]
	assert.equal(templates.learn(before, [n0]), true)
	assert.ok(templates.version > version)
	preparation.templateGates(); assert.equal(scans, 2)
	await assert.rejects(massOptimizeStep(portfolio, new LimitedMap(10), new LimitedMap(10), gates.slice(), 2, false, false, true, preparation), /different circuit/)
	templates.rewrite = originalRewrite
	const activity = { passes: 0, subsets: 0, checks: 0, improvements: 0, stage: 'searching' as const }
	const source = Array.from({ length: 300 }, () => n0)
	const nativeArray = ChunkedSequence.prototype.toArray
	let snapshots = 0, edits = 0
	ChunkedSequence.prototype.toArray = function() { snapshots++; return nativeArray.call(this) }
	try {
		const result = await optimizeSubset(portfolio, source, new LimitedMap(100), new LimitedMap(100), 3, 199, 'heavy', () => false, activity, () => { throw new Error('eager snapshot') }, new LimitedMap(100), 'rainbow', () => { edits++; assert.equal(snapshots, 0) })
		assert.ok(edits > 1); assert.equal(snapshots, 1)
		assert.deepEqual(calculateAllOutputsArray(result, generateCombinations(3)), calculateAllOutputsArray(source, generateCombinations(3)))
	} finally { ChunkedSequence.prototype.toArray = nativeArray }
} finally { templates.rewrite = originalRewrite; await portfolio.close() }

const directory = await mkdtemp(join(tmpdir(), 'coverage-proof-')), previousCwd = process.cwd()
try {
	process.chdir(directory)
	const specs = [{ wires: 2, gates: 2 }, { wires: 3, gates: 1 }]
	await initializeRainbowTables(specs)
	const tables = await openRainbowPortfolio(specs)
	try {
		const cn0 = { a: 1, b: 0, target: 0, gate_i: 3 }, cn1 = { a: 0, b: 0, target: 1, gate_i: 3 }
		assert.equal((await tables.findReplacements([{ wires: 2, mappedGates: [cn0, cn1, cn0] }], new LimitedMap(100))).size, 0)
		assert.deepEqual(tables.statistics().map(s => s.windows), [1, 0], 'dominated table is skipped only for fitting windows')
		await tables.findReplacements([{ wires: 3, mappedGates: [{ a: 0, b: 1, target: 2, gate_i: 1 }] }], new LimitedMap(100))
		assert.equal(tables.statistics()[1].windows, 1)
	} finally { await tables.close() }
	const inspect = new sqlite3.Database(databaseFilename(2, 2))
	try {
		assert.equal(await hasCanonicalCoverage(inspect, 2, 2), true)
		await runSQL(inspect, "UPDATE BuildMeta SET signature='wrong catalogue'")
		assert.equal(await hasCanonicalCoverage(inspect, 2, 2), false)
	} finally { await new Promise<void>((resolve, reject) => inspect.close(error => error ? reject(error) : resolve())) }
} finally { process.chdir(previousCwd); await rm(directory, { recursive: true, force: true }) }
for (const value of [0, -1, 1.5]) {
	assert.throws(() => parseConfig({ search: { circuitChunkGates: value } }))
	assert.throws(() => parseConfig({ database: { statementCacheEntries: value } }))
}
console.log('Subset reuse, coverage proofs, weighted intervals, prepared statement lifecycle and chunked circuit regressions passed')
