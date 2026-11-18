import assert from 'node:assert/strict'
import { StrategyPicker } from './strategy-picker.js'
import { advancedRewrite, templates } from './strategies.js'
import { config } from './config.js'
import { forwardSemanticSearch, meetInMiddle } from './semantic.js'
import { saturateCircuit } from './equality.js'
import { synthesizeSMT } from './smt.js'
import { Gate } from './types.js'
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
	Object.assign(config.synthesis, { factored: false, blockCancellation: false, satSweeping: false, quadratic: false, affine: true, smt: false, forwardSemanticSearch: false, meetInMiddle: false, equalitySaturation: false })
	const input = [not, not, not]
	assert.equal(await advancedRewrite(input, { deadline: -Infinity }), undefined)
	assert.equal(await advancedRewrite(input, { deadline: performance.now() + 5000, shouldStop: () => true }), undefined)
	assert.deepEqual(await advancedRewrite(input, { deadline: performance.now() + 5000 }), [not], 'expired/canceled jobs do not poison future solver attempts')
} finally { Object.assign(config.synthesis, saved) }
assert.equal(forwardSemanticSearch([not], 2, 2, 100000, 30000, () => true), undefined)
assert.equal(meetInMiddle([not], 2, [not], 2, 100000, 30000, () => true), undefined)
assert.equal(saturateCircuit([not], 2, templates, 100000, 30000, () => true), undefined)
let cancellationChecks = 0
const started = performance.now()
assert.equal(await synthesizeSMT([not], 2, 3, 30000, () => { cancellationChecks++; return performance.now() - started > 10 }), undefined)
assert.ok(cancellationChecks > 1, 'SMT observes cancellation while its isolate is running')
console.log('Fixed solver rotation, eligibility skips, shared job expiry, cancellation and retry safety passed')
