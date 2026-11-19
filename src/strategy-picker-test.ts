import assert from 'node:assert/strict'
import { StrategyPicker } from './strategy-picker.js'
import { advancedRewrite } from './strategies.js'
import { config, parseConfig } from './config.js'
import { forwardSemanticSearch, meetInMiddle } from './semantic.js'
import { saturateCircuit } from './equality.js'
import { synthesizeSMT } from './smt.js'
import { Gate } from './types.js'
import { WorkerPool } from './threads.js'
import { createSharedTable } from './shared-table.js'
import { broadStrategyOrder, createOptimizerCaches } from './processing.js'
const picker = new StrategyPicker(['GF2', 'forward', 'Z3'])
const choices = ['GF2', 'forward', 'Z3'].map(name => ({ name }))
assert.deepEqual(Array.from({ length: 6 }, () => picker.pick(choices)?.name), ['GF2', 'forward', 'Z3', 'GF2', 'forward', 'Z3'])
assert.equal(picker.pick([choices[2]])?.name, 'Z3')
assert.equal(picker.pick([]), undefined)
assert.equal(picker.pick(choices)?.name, 'GF2')
for (let i = 0; i < 5; i++) picker.pick([choices[0]])
assert.equal(picker.pick(choices)?.name, 'forward', 'affine-only regions must not starve the other solvers on small regions')
const not: Gate = { a: 0, b: 0, target: 0, gate_i: 15 }
const saved = { ...config.synthesis }
try {
	Object.assign(config.synthesis, { factored: false, blockCancellation: false, satSweeping: false, mixedBasis: false, quadratic: false, affine: true, smt: false, forwardSemanticSearch: false, meetInMiddle: false, equalitySaturation: false })
	const input = [not, not, not]
	assert.equal(await advancedRewrite(input, { deadline: -Infinity }), undefined)
	assert.equal(await advancedRewrite(input, { deadline: performance.now() + 5000, shouldStop: () => true }), undefined)
	assert.deepEqual(await advancedRewrite(input, { deadline: performance.now() + 5000 }), [not], 'expired/canceled jobs do not poison future solver attempts')
} finally { Object.assign(config.synthesis, saved) }
assert.equal(forwardSemanticSearch([not], 2, 2, 100000, 30000, () => true), undefined)
assert.equal(meetInMiddle([not], 2, [not], 2, 100000, 30000, () => true), undefined)
assert.equal(saturateCircuit([not], 2, 100000, 30000, () => true), undefined)
let cancellationChecks = 0
const started = performance.now()
assert.equal(await synthesizeSMT([not], 2, 3, 30000, () => { cancellationChecks++; return performance.now() - started > 10 }), undefined)
assert.ok(cancellationChecks > 1, 'SMT observes cancellation while its isolate is running')
const legacyNames = parseConfig({
	strategies: { rainbow: { enabled: false }, quadraticShear: { enabled: false }, smt: { enabled: false } },
	search: { localStrategyOrder: ['rainbow', 'quadratic', 'z3'], broadStrategyOrder: ['quadratic-shear', 'symbolic'] },
})
assert.equal(legacyNames.search.rainbow, false)
assert.equal(legacyNames.synthesis.quadraticShear, false)
assert.equal(legacyNames.synthesis.smt, false)
assert.deepEqual(legacyNames.search.localStrategyOrder, ['truth-table-lookup', 'anf-synthesis', 'smt-synthesis'])
assert.deepEqual(legacyNames.search.broadStrategyOrder, ['quadratic-shear-interpolation', 'polynomial-region-search'])
assert.throws(() => parseConfig({ search: { localStrategyOrder: ['quadratic', 'anf-synthesis'] } }), /localStrategyOrder/)
assert.throws(() => parseConfig({ strategies: { smt: {}, smtSynthesis: {} } }), /Duplicate strategy group/)
assert.throws(() => parseConfig({ search: { localStrategyOrder: ['dependency-cuts'] } }), /localStrategyOrder/)
assert.throws(() => parseConfig({ search: { broadStrategyOrder: ['sat-sweeping', 'sat-sweeping'] } }), /broadStrategyOrder/)
assert.throws(() => parseConfig({ search: { broadStrategyOrder: 'quadratic-shear-interpolation' } }), /broadStrategyOrder/)
const search = { ...config.search }
const tables = config.database.tables
const table = { wires: 2, gates: 1 }
const pool = new WorkerPool(2, undefined, [createSharedTable(table, [], 1024)!])
try {
	Object.assign(config.search, { rainbow: true, strategyAdaptive: true, localStrategyOrder: [], broadStrategyOrder: [] })
	config.synthesis.quadratic = true
	for (const index of [0, 1, 7]) {
		const { strategyPicker } = createOptimizerCaches(index)
		strategyPicker.beginRound(1)
		assert.equal(strategyPicker.activeStrategy, 'anf-synthesis')
		strategyPicker.beginRound(2)
		assert.equal(strategyPicker.activeStrategy, 'truth-table-lookup')
	}
	const custom = parseConfig({ search: {
		localStrategyOrder: ['quadratic-shear-interpolation'],
		broadStrategyOrder: ['quadratic-shear-interpolation'],
	} })
	Object.assign(config.search, custom.search)
	const reordered = createOptimizerCaches(7)
	assert.equal(reordered.strategyPicker.activeStrategy, 'quadratic-shear-interpolation')
	reordered.strategyPicker.beginRound(1)
	reordered.strategyPicker.beginRound(2)
	assert.equal(reordered.strategyPicker.activeStrategy, 'anf-synthesis', 'omitted strategies remain in rotation')
	assert.deepEqual(broadStrategyOrder().slice(0, 2), ['quadratic-shear-interpolation', 'sat-sweeping'])
	const shearEnabled = config.synthesis.quadraticShear
	try {
		config.synthesis.quadraticShear = false
		assert.equal(broadStrategyOrder()[0], 'sat-sweeping', 'disabled strategies stay disabled when prioritized')
	} finally {
		config.synthesis.quadraticShear = shearEnabled
	}
	Object.assign(config.search, search, { localStrategyOrder: [], broadStrategyOrder: [] })

	config.synthesis.quadratic = false
	config.database.tables = [table]
	pool.setBroadReservation(true)
	await pool.run([not], 2, undefined, undefined, 100, false, 'broad', 1)
	let firstLocalStrategy: string | undefined
	await pool.run([not], 2, (_, activity) => { firstLocalStrategy ??= activity?.activeStrategy },
		undefined, 20, false, 'local', 1)
	assert.equal(firstLocalStrategy, 'truth-table-lookup', 'starting a broad worker first preserves the first local strategy')
	Object.assign(config.search, { subsetMinimum: 2, subsetMaximum: 2, sliceMinimum: 2, sliceMaximum: 2 })
	const limitedPool = new WorkerPool(2, undefined, [createSharedTable(table, [], 1024)!], undefined, 1)
	try {
		const checks = [0, 0, 0]
		await Promise.all(checks.map((_, i) => limitedPool.run([not, not], 2, (_count, activity) => {
			checks[i] = activity?.checks ?? 0
		}, undefined, 1000)))
		assert.equal(checks.reduce((sum, count) => sum + count, 0), 1)
	} finally { await limitedPool.close() }
	config.search.strategyAdaptive = false
	config.synthesis.quadratic = true
	const assignedPool = new WorkerPool(1, undefined, [createSharedTable(table, [], 1024)!])
	try {
		for (const strategy of ['anf-synthesis', 'quadratic-shear-interpolation', 'truth-table-lookup']) {
			let reported: string | undefined
			const input = [not, not]
			const result = await assignedPool.run(input, 2, (_, activity) => { reported = activity?.activeStrategy },
				undefined, 100, false, 'local', 1, strategy)
			assert.equal(reported, strategy)
			assert.deepEqual(result, strategy === 'truth-table-lookup' ? input : [])
		}
	} finally { await assignedPool.close() }

} finally {
	await pool.close()
	Object.assign(config.search, search)
	config.synthesis.quadratic = saved.quadratic
	config.database.tables = tables
}

console.log('Fixed solver rotation, eligibility skips, shared job expiry, cancellation and retry safety passed')
