import assert from 'node:assert/strict'
import {dependencySort,findConvexSubsets,dependencyGraphToMap} from './utils.js'
import {createDependencyGraph} from './lineswapper.js'
const gates=Array.from({length:2000},(_,i)=>({a:i%8,b:(i+1)%8,target:(i+2)%8,gate_i:1}))
const nodes=createDependencyGraph(gates), map=dependencyGraphToMap(nodes)
let checks=0
assert.deepEqual(dependencySort(map,nodes[nodes.length-1],199,nodes,gates,undefined,()=>++checks>3),[])
assert.ok(checks>3)
checks=0
assert.deepEqual([...findConvexSubsets(199,gates,undefined,undefined,[],()=>++checks>3)],[])
assert.ok(checks>3)
assert.deepEqual([...findConvexSubsets(199,gates,undefined,undefined,[],()=>true)],[])
console.log('Dependency preparation checks cancellation inside selection and never emits a partial unproved region')

checks=0
const region=dependencySort(map,nodes[nodes.length-1],199,nodes,gates,undefined,()=>{assert.ok(++checks<100000,'dependency traversal must make forward progress');return false})
assert.equal(region.length,199)
assert.equal(new Set(region).size, region.length)
