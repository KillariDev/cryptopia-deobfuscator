import assert from 'node:assert/strict'
import { AdaptiveStrategyPicker } from './strategy-picker.js'
import { parseConfig } from './config.js'
let now = 0, draw = 0
const options = () => ({ enabled: true, exploration: 0.2, halfLifeSeconds: 60 })
const names = ['variables', 'rainbow', 'synthesis']
const choices = names.map(name => ({ name }))
const picker = new AdaptiveStrategyPicker(names, options, () => draw, () => now)
assert.deepEqual(picker.probabilities(names), [1/3, 1/3, 1/3])
assert.deepEqual(picker.weights(), names.map(strategy => ({ strategy, weight: 1, attempts: 0 })))
picker.observe('rainbow', 100, 100)
const warmup = picker.probabilities(names)
assert.ok(warmup[0] > warmup[1] && warmup[2] > warmup[1])
assert.ok(warmup.every(p => p >= 0.2/3), 'even warmup retains the exploration floor')
picker.observe('variables', 0, 100)
picker.observe('synthesis', 0, 100)
const learned = picker.probabilities(names)
assert.ok(learned[1] > learned[0] && learned[1] > learned[2])
assert.ok(learned.every(p => p >= 0.2/3))
assert.ok(picker.weights()[1].weight > picker.weights()[0].weight)
assert.equal(picker.weights()[1].attempts, 1)
const counts = [0,0,0]
for(let i=0;i<10000;i++) { draw=(i+0.5)/10000; counts[names.indexOf(picker.pick(choices)!.name)]++ }
assert.ok(counts[1] > counts[0] && counts[0] >= 666 && counts[2] >= 666)
now=60*1000*40
assert.ok(picker.probabilities(names).every(p => Math.abs(p-1/3)<1e-6), 'wall-clock decay removes stale preferences')
assert.ok(picker.weights().every(entry => Math.abs(entry.weight - 1) < 1e-6), 'reported weights include wall-clock decay')
for(let i=0;i<30;i++) { picker.observe('rainbow',0,100); picker.observe('variables',100,100) }
assert.ok(picker.probabilities(names)[0] > picker.probabilities(names)[1], 'change preference when productivity changes')
assert.equal(picker.pick([]), undefined)
assert.equal(picker.pick([{name:'synthesis'}])!.name,'synthesis')
const cost = new AdaptiveStrategyPicker(['fast','slow'], options, () => 0, () => 0)
cost.observe('fast',10,10); cost.observe('slow',10,10000)
assert.ok(cost.probabilities(['fast','slow'])[0] > cost.probabilities(['fast','slow'])[1], 'reward reductions per elapsed worker time')
assert.throws(() => parseConfig({search:{strategyExplorationProbability:0}}))
assert.throws(() => parseConfig({search:{strategyExplorationProbability:1.1}}))
assert.throws(() => parseConfig({search:{strategyDecayHalfLifeSeconds:0}}))
console.log('Adaptive strategies: equal start, warmup/exploration floor, productivity weighting, cost normalization, time decay and recovery passed')

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
	Object.assign(config.synthesis, { templates: false, affine: false, quadratic: false, forwardSemanticSearch: false, smt: false, meetInMiddle: false, equalitySaturation: false })
	await runSQL(db,'CREATE TABLE InputOutputReplacers(ioIdentifier BLOB PRIMARY KEY,replacerGates BLOB NOT NULL) WITHOUT ROWID')
	const cn = {a:1,b:0,target:0,gate_i:3}, not1 = {a:0,b:0,target:1,gate_i:15}
	const input = [cn,not1,cn], expected = [not1,{...not1,target:0}]
	await runSQL(db,'INSERT INTO InputOutputReplacers VALUES (?,?)',[Buffer.from(functionKey(input,3),'hex'),encodeGates(expected)])
	let sample=0
	const methods=new AdaptiveStrategyPicker(['variables','rainbow'],options,()=>sample)
	const cache=new LimitedMap<string,boolean>(100), lookup=new LimitedMap<string,import('./types.js').Gate[]|null>(100)
	const prep=new SubsetPreparation(input)
	assert.equal((await massOptimizeStep(tables,lookup,cache,input,3,false,true,true,prep,undefined,methods)).changed,false)
	sample=0.5
	const hit=await massOptimizeStep(tables,lookup,cache,input,3,false,true,true,prep,undefined,methods)
	assert.equal(hit.changed,true)
	assert.equal(functionKey(hit.gates,3),functionKey(input,3))
	assert.equal(hit.gates.length,2,'rainbow can still try a region after variables failed')
} finally { Object.assign(config,saved); await tables.close() }
console.log('Adaptive strategy cache isolation and exact replacement integration passed')
