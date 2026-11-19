import assert from 'node:assert/strict'
import { RoundStrategyPicker } from './strategy-picker.js'

const choices = ['rainbow', 'variables', 'forward-semantic-search'].map(name => ({ name }))
const first = new RoundStrategyPicker(choices.map(choice => choice.name))
const second = new RoundStrategyPicker(choices.map(choice => choice.name), 1)
first.beginRound(1)
second.beginRound(1)
assert.equal(first.pick(choices)?.name, 'rainbow')
assert.equal(second.pick(choices)?.name, 'variables')
first.observe('rainbow', 1)
first.observe('rainbow', 0)
first.beginRound(1)
assert.equal(first.pick(choices)?.name, 'rainbow', 'new jobs in the same round preserve the strategy and reductions')
first.beginRound(2)
second.beginRound(2)
assert.equal(first.pick(choices)?.name, 'rainbow', 'a reduction keeps the strategy for the next round')
assert.equal(second.pick(choices)?.name, 'forward-semantic-search', 'a dry round moves to the next strategy')
assert.equal(second.pick(choices.slice(0, 2)), undefined, 'ineligible regions do not switch strategies mid-round')
first.observe('variables', 9)
first.beginRound(3)
assert.equal(first.pick(choices)?.name, 'variables', 'another solver cannot credit the active strategy')
second.beginRound(3)
assert.equal(second.pick(choices)?.name, 'rainbow', 'the last strategy wraps to the first')

const broadRefill = new RoundStrategyPicker(choices.map(choice => choice.name), 2)
broadRefill.beginRound(1, 'rainbow')
assert.equal(broadRefill.pick(choices)?.name, 'rainbow', 'a worker uses the coordinator assignment regardless of its slot')
broadRefill.observe('rainbow', 4)
broadRefill.beginRound(2, 'variables')
assert.equal(broadRefill.pick(choices)?.name, 'variables', 'the assigned rotation takes precedence over local observations')

// Trying one method must not hide the same region from another method's cache.
const { config } = await import('./config.js')
const { massOptimizeStep, SubsetPreparation } = await import('./processing.js')
const { RainbowPortfolio } = await import('./rainbow-portfolio.js')
const { LimitedMap } = await import('./limitedMap.js')
const { runSQL } = await import('./sql.js')
const { functionKey, encodeGates } = await import('./semantic.js')
const sqlite3 = (await import('sqlite3')).default
const saved = structuredClone(config)
const db = new sqlite3.Database(':memory:')
const tables = new RainbowPortfolio([{ wires: 3, gates: 2, db }])
try {
	config.search.strategyAdaptive = true
	Object.assign(config.synthesis, { factored: false, blockCancellation: false, satSweeping: false, mixedBasis: false, affine: false, quadratic: false, forwardSemanticSearch: false, smt: false, meetInMiddle: false, equalitySaturation: false })
	await runSQL(db,'CREATE TABLE InputOutputReplacers(ioIdentifier BLOB PRIMARY KEY,replacerGates BLOB NOT NULL) WITHOUT ROWID')
	const cn = {a:1,b:0,target:0,gate_i:3}, not1 = {a:0,b:0,target:1,gate_i:15}
	const input = [cn,not1,cn], expected = [not1,{...not1,target:0}]
	await runSQL(db,'INSERT INTO InputOutputReplacers VALUES (?,?)',[Buffer.from(functionKey(input,3),'hex'),encodeGates(expected)])
	const methods=new RoundStrategyPicker(['variables','rainbow'])
	methods.beginRound(1)
	const cache=new LimitedMap<string,boolean>(100), lookup=new LimitedMap<string,import('./types.js').Gate[]|null>(100)
	const prep=new SubsetPreparation(input)
	assert.equal((await massOptimizeStep(tables,lookup,cache,input,3,false,true,true,prep,undefined,methods)).changed,false)
	methods.beginRound(2)
	const hit=await massOptimizeStep(tables,lookup,cache,input,3,false,true,true,prep,undefined,methods)
	assert.equal(hit.changed,true)
	assert.equal(functionKey(hit.gates,3),functionKey(input,3))
	assert.equal(hit.gates.length,2,'rainbow can still try a region after variables failed')
} finally { Object.assign(config,saved); await tables.close() }
console.log('Round strategy cache isolation and exact replacement integration passed')
