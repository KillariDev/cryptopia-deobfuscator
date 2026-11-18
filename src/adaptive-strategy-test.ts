import assert from 'node:assert/strict'
import { AdaptiveStrategyPicker } from './strategy-picker.js'
import { parseConfig } from './config.js'
let now = 0, draw = 0
const options = () => ({ enabled: true, startingWeights: {}, specialize: false, exploration: 0.2, halfLifeSeconds: 60 })
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
for (let i=0;i<2;i++) { picker.observe('variables',0,100); picker.observe('rainbow',100,100); picker.observe('synthesis',0,100) }
const learned = picker.probabilities(names)
assert.ok(learned[1] > learned[0] && learned[1] > learned[2])
assert.ok(learned.every(p => p >= 0.2/3))
assert.ok(picker.weights()[1].weight > picker.weights()[0].weight)
assert.equal(picker.weights()[1].attempts, 3)
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
for(let i=0;i<3;i++){cost.observe('fast',10,10); cost.observe('slow',10,10000)}
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
	Object.assign(config.synthesis, { factored: false, blockCancellation: false, satSweeping: false, templates: false, affine: false, quadratic: false, forwardSemanticSearch: false, smt: false, meetInMiddle: false, equalitySaturation: false })
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

// A successful strategy gets a temporary lease while uniform exploration stays live.
let focusClock=0, focusDraw=0
const focused=new AdaptiveStrategyPicker(['a','b'],()=>({enabled:true,exploration:0.2,halfLifeSeconds:60}),()=>focusDraw,()=>focusClock)
const both=[{name:'a'},{name:'b'}]
for(let i=0;i<3;i++){focused.observe('a',0,10);focused.observe('b',100,10)}
assert.equal(focused.pick(both)?.name,'b')
focusDraw=0.85;assert.equal(focused.pick(both)?.name,'a','uniform exploration can leave the specialist')
assert.equal(focused.pick([{name:'a'}])?.name,'a','ineligible specialists never block work')
focused.observe('b',0,1);focused.observe('b',0,1);focused.observe('b',0,1)
focusDraw=0;assert.equal(focused.pick(both)?.name,'a','three misses release the lease')
for(let i=0;i<3;i++)focused.observe('b',100,10);focusClock=30001
assert.equal(focused.pick(both)?.name,'a','idle leases expire')
focused.observe('b',1,10)
for(let i=0;i<16;i++)assert.equal(focused.pick(both)?.name,'b')
assert.equal(focused.pick(both)?.name,'a','leases also bound attempts without observations')
console.log('Temporary strategy specialization: success, exploration, eligibility, misses, age and attempt bounds passed')

const fair=new AdaptiveStrategyPicker(['a','b','c'],()=>({...options(),specialize:true}),()=>0.1,()=>0)
fair.observe('a',1000000,0.001)
assert.ok(fair.weights()[0].weight <= 1 + 3/9,'one extreme sample stays weak')
assert.equal(fair.pick([{name:'a'},{name:'b'},{name:'c'}])?.name,'b','first winner cannot bypass unsampled peers')
for(let round=0;round<3;round++)for(const name of ['a','b','c'])fair.observe(name,10,10)
const equal=fair.weights().map(x=>x.weight)
assert.ok(Math.max(...equal)-Math.min(...equal)<0.3,'similar productive tools retain similar weights despite an early outlier')
assert.ok(equal.every(weight=>weight<=4),'weight growth is bounded')
assert.equal(fair.pick([{name:'a'},{name:'b'},{name:'c'}])?.name,'a','equally productive peers do not grant the last winner a specialist lease')
console.log('First-success bias: balanced warmup, smoothed early evidence, comparable easy-case weights and bounded growth passed')

const defaults = new AdaptiveStrategyPicker(['variables','templates','forward-semantic-search','equality-saturation','rainbow'],()=>({enabled:true,exploration:0.2,halfLifeSeconds:60}))
assert.deepEqual(defaults.weights().map(x=>x.weight),[5,5,5,5,1])
assert.ok(defaults.probabilities(['variables','rainbow'])[0]>defaults.probabilities(['variables','rainbow'])[1])
defaults.observe('variables',0,10)
assert.ok(defaults.weights()[0].weight<5,'starting priors fade as actual evidence arrives')
console.log('Preferred starting weights: variables, templates, forward and equality start at 5x and yield to evidence')

const balanced=new AdaptiveStrategyPicker(['variables','rainbow'],()=>({enabled:true,exploration:0.2,halfLifeSeconds:60}),()=>0.5)
const seen={variables:0,rainbow:0}
for(let i=0;i<6;i++){const name=balanced.pick([{name:'variables'},{name:'rainbow'}])!.name as keyof typeof seen;seen[name]++;balanced.observe(name,1,1)}
assert.deepEqual(seen,{variables:3,rainbow:3},'starting priors do not bypass the balanced sampling rounds')
