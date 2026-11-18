import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { Gate } from './types.js'
import { analyzeFactored, FactoredGraph, FactoredOptions, Form, synthesizeFactored } from './factored.js'
import { cancelBlocks } from './block-cancellation.js'
import { sweepFactored, SweepStats } from './sat-sweeping-core.js'
import { structuralRewrite, structuralNames } from './structural-strategies.js'
import { evalCircuit, generateCombinations, verifyCircuit } from './utils.js'
import { seededRandom } from './random.js'
import { config } from './config.js'
import { AdaptiveStrategyPicker } from './strategy-picker.js'
import { createOptimizerCaches, massOptimizeStep, SubsetPreparation } from './processing.js'
import { RainbowPortfolio } from './rainbow-portfolio.js'
import { LimitedMap } from './limitedMap.js'
import { strategySnapshot, resetStrategyStats } from './strategy-stats.js'
import sqlite3 from 'sqlite3'

const options: FactoredOptions = { maximumWires: 64, maximumNodes: 200000, maximumEdges: 16000000, stopped: () => false }
const equivalent = (before: Gate[], after: Gate[], wires: number) => {
	for (const input of generateCombinations(wires)) assert.deepEqual(evalCircuit(before, input), evalCircuit(after, input))
}
const values = (graph: FactoredGraph, rows: Form[], input: boolean[]) => {
	const atoms = [true, ...graph.wires.map(wire => input[wire])]
	const value = (form: Form) => form.atoms.reduce((result, atom) => result !== atoms[atom], false)
	for (const node of graph.products) atoms.push(value(node.left) && value(node.right))
	return rows.map(value)
}
// All truth functions, aliased controls/targets, and exact graph semantics.
for (let gate_i = 0; gate_i < 16; gate_i++) for (let a = 0; a < 3; a++) for (let b = 0; b < 3; b++) for (let target = 0; target < 3; target++) {
	const input = [{ a, b, target, gate_i }], { graph, rows } = analyzeFactored(input, options)
	const compact = graph.rebuild(rows, new Map())
	for (const bits of generateCombinations(3)) {
		assert.deepEqual(values(graph, rows, bits), graph.wires.map(wire => evalCircuit(input, bits)[wire]))
		assert.deepEqual(values(compact.graph, compact.rows, bits), values(graph, rows, bits))
	}
}
const t: Gate = { a: 0, b: 1, target: 2, gate_i: 1 }
const random = seededRandom(20261123), pick = (n: number) => Math.floor(random() * n)
for (let wires = 3; wires <= 6; wires++) for (let trial = 0; trial < 8; trial++) {
	const word: Gate[] = Array.from({ length: 30 }, () => {
		const target = pick(wires), controls = Array.from({ length: wires }, (_, i) => i).filter(wire => wire !== target)
		return { a: controls[pick(controls.length)], b: controls[pick(controls.length)], target, gate_i: pick(16) }
	})
	const input = [...word, ...word.slice().reverse(), t], copy = structuredClone(input)
	const output = synthesizeFactored(input, options)
	assert.ok(output && output.length === 1)
	equivalent(input, output, wires)
	assert.deepEqual(input, copy)
}
assert.equal(synthesizeFactored([t, t], { ...options, stopped: () => true }), undefined)
assert.equal(synthesizeFactored([t, t], { ...options, maximumNodes: 1 }), undefined)
assert.equal(synthesizeFactored([t, t], { ...options, maximumEdges: 1 }), undefined)
assert.equal(synthesizeFactored([t, t], { ...options, maximumWires: 2 }), undefined)

// Generic cubic shears: block cancellation works without a quadratic output.
const a = [t, { a: 2, b: 3, target: 4, gate_i: 1 }, t]
const b = [t, { a: 2, b: 3, target: 5, gate_i: 1 }, t]
const blockInput = [...a, ...b, ...a], blockResult = cancelBlocks(blockInput, options)
assert.ok(blockResult && blockResult.length === b.length)
equivalent(blockInput, blockResult, 6)
assert.equal(synthesizeFactored(blockInput, options), undefined, 'cubic output needs block reasoning rather than the quadratic emitter')
const noncommuting = [...a, { a: 0, b: 0, target: 0, gate_i: 15 }, ...a]
const rejected = cancelBlocks(noncommuting, options)
if (rejected) equivalent(noncommuting, rejected, 5)
const aliased = [{ a: 0, b: 0, target: 0, gate_i: 3 }]
assert.equal(cancelBlocks([...aliased, ...aliased], options), undefined, 'target-reading gates are not assumed involutions')
assert.equal(cancelBlocks(blockInput, { ...options, stopped: () => true }), undefined)

// Distributivity hidden behind a nonlinear factor; structural hashing and the
// quadratic emitter cannot prove this identity, whereas a SAT miter can.
const cnot: Gate = { a: 3, b: 0, target: 4, gate_i: 3 }
const distributed = [t, cnot, { a: 2, b: 4, target: 5, gate_i: 1 }, cnot, { a: 2, b: 3, target: 5, gate_i: 1 }, { a: 2, b: 4, target: 5, gate_i: 1 }, t]
assert.equal(synthesizeFactored(distributed, options), undefined)
equivalent(distributed, [], 6)
const stats = { queries: 0, merges: 0, counterexamples: 0 }
const swept = await sweepFactored(distributed, options, performance.now() + 30000, stats)
assert.deepEqual(swept, [])
assert.ok(stats.queries > 0 && stats.merges > 0, 'a real UNSAT proof authorizes the rewrite')
const collisions: SweepStats = { queries: 0, merges: 0, counterexamples: 0 }
assert.equal(await sweepFactored([t], { ...options, simulationBits: 1 }, performance.now() + 30000, collisions), undefined)
assert.ok(collisions.counterexamples > 0, 'simulation collisions must not authorize a merge')
assert.ok(collisions.refinementSkips! > 0, 'model counterexamples prevent redundant queries against distinguishable expressions')
assert.equal(await structuralRewrite('sat-sweeping', distributed, performance.now() + 30000, () => true), undefined)
let cancellationChecks = 0
assert.equal(await structuralRewrite('sat-sweeping', distributed, performance.now() + 30000, () => ++cancellationChecks > 2), undefined)

// Each solver is selected and measured independently of the original toolkit.
const saved = structuredClone(config), tables = new RainbowPortfolio([{ wires: 3, gates: 3, db: new sqlite3.Database(':memory:') }])
try {
	Object.assign(config.synthesis, { templates: false, affine: false, quadratic: false, forwardSemanticSearch: false, smt: false, meetInMiddle: false, equalitySaturation: false, factored: true, blockCancellation: true, satSweeping: true })
	config.search.strategyAdaptive = true
	const cases = { factored: [t, t, t], 'block-cancellation': blockInput, 'sat-sweeping': distributed }
	for (const name of structuralNames) {
		resetStrategyStats()
		const input = cases[name], picker = new AdaptiveStrategyPicker([name], () => ({ enabled: true, exploration: 0.2, halfLifeSeconds: 300 }))
		const result = await massOptimizeStep(tables, new LimitedMap(100), new LimitedMap(100), input, input.length, false, false, false, new SubsetPreparation(input), { deadline: performance.now() + 30000 }, picker)
		assert.equal(result.changed, true)
		equivalent(input, result.gates, 6)
		assert.equal(strategySnapshot().filter(stat => stat.strategy === name).reduce((sum, stat) => sum + stat.attempts, 0), 1)
		assert.equal(picker.weights()[0].attempts, 1)
	}
	const caches = createOptimizerCaches()
	for (const picker of [caches.strategyPicker, caches.broadStrategyPicker]) for (const name of structuralNames) assert.ok(picker.weights().some(weight => weight.strategy === name))
} finally { Object.assign(config, saved); await tables.close() }

// Full-size challenge: no seed, partition, proof, or solution file is supplied.
const puzzle = JSON.parse(readFileSync(new URL('../data/nonlinear-basis-maze.json', import.meta.url), 'utf8'))
const maze: Gate[] = puzzle.gates.map(([a, b, target, gate_i]: number[]) => ({ a, b, target, gate_i }))
const solved = synthesizeFactored(maze, options)
assert.equal(solved?.length, 1000)
verifyCircuit(maze, solved!, 64, 64)
const blocked = cancelBlocks(maze, options)
assert.ok(blocked && blocked.length < maze.length / 2)
verifyCircuit(maze, blocked, 64, 64)
console.log('Structural toolkit: all gate functions, exact factored synthesis, inferred block cancellation, SAT-proved sweeping, collision rejection, cancellation, selection and the 100k nonlinear maze passed')
