import assert from 'node:assert/strict'
import { SharedLearning, learningBytes } from './shared-learning.js'
import { SearchProgress } from './search-progress.js'
import { broadRegions } from './broad-search.js'
import { SolverService } from './solver-worker.js'
const buffer=new SharedArrayBuffer(learningBytes)
let now=600000
const a=new SharedLearning(buffer,()=>now),b=new SharedLearning(buffer,()=>now)
a.observe('rainbow',10,1000)
assert.equal(b.rate('rainbow',300),10)
now+=300000;assert.equal(b.rate('rainbow',300),5)
now+=480000;assert.equal(b.rate('rainbow',300),undefined)
const progress=new SearchProgress(), gates=Array.from({length:100},(_,target)=>({a:0,b:0,target,gate_i:15}))
progress.reset(gates,()=>broadRegions(gates.length))
assert.equal(progress.next(2)?.slice,100)
progress.reset(structuredClone(gates),()=>broadRegions(gates.length))
assert.equal(progress.next(2)?.slice,50,'resume on an equal but newly cloned checkpoint')
const changed=gates.slice();changed[50]={...changed[50],gate_i:0}
progress.reset(changed,()=>broadRegions(changed.length))
assert.deepEqual(progress.next(2),{start:18,end:82,slice:64},'prioritize changed neighborhood')
const service=new SolverService()
const fixture=new URL('data:text/javascript,'+encodeURIComponent(`import {parentPort} from 'node:worker_threads';let n=0;parentPort.on('message',()=>parentPort.postMessage({result:Array.from({length:++n},()=>({a:0,b:0,target:0,gate_i:15}))}));`))
assert.equal((await service.run(fixture,{},1000,()=>false))?.length,1)
assert.equal((await service.run(fixture,{},1000,()=>false))?.length,2,'reuse the same isolate')
assert.equal(await service.run(fixture,{},1000,()=>true),undefined)
console.log('Search reuse: shared decaying evidence, exact checkpoint cursors, changed-region priority and persistent isolated solver passed')
