import assert from 'node:assert/strict'
import {mkdtemp,readFile,rm} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {SolverService} from './solver-worker.js'
import {config} from './config.js'
import {CheckpointWriter} from './checkpoint-writer.js'
import {splitTaskAndRun} from './processing.js'
import {outputPaths} from './storage.js'
import {AsyncReductionCheckpoint} from './storage.js'
import {IncrementalGraph} from './incremental-graph.js'
import {createDependencyGraph} from './lineswapper.js'
import {sweepFactored,SweepStats} from './sat-sweeping-core.js'
import {init,killThreads} from 'z3-solver'
import {setTimeout as wait} from 'node:timers/promises'
const service=new SolverService()
const fixture=new URL('data:text/javascript,'+encodeURIComponent(`import {parentPort} from 'node:worker_threads';parentPort.on('message',async()=>{await new Promise(r=>setTimeout(r,30));parentPort.postMessage({result:[]})})`))
const first=service.run(fixture,{},1000,()=>false)
assert.ok(service.busy)
assert.equal(await service.run(fixture,{},1000,()=>false),undefined,'busy SAT work is skipped instead of queued')
assert.deepEqual(await first,[]);assert.equal(service.busy,false)
const recovered = new SolverService()
const idleFailure = new URL('data:text/javascript,'+encodeURIComponent(`
 import {parentPort} from 'node:worker_threads'
 parentPort.on('message', ({ fail }) => {
  parentPort.postMessage({result:[]})
  if (fail) setTimeout(() => { throw new Error('injected idle worker failure') }, 5)
 })
`))
assert.deepEqual(await recovered.run(idleFailure,{fail:true},1000,()=>false),[])
await wait(100)
assert.deepEqual(await recovered.run(idleFailure,{fail:false},1000,()=>false),[],'idle worker errors leave the service reusable')
const cn={a:0,b:0,target:1,gate_i:3}
const gates=Array.from({length:1000},()=>({...cn}))
const graph=new IncrementalGraph(gates)
let recomputed=0
const internals=graph as unknown as {recompute:(ids:Set<number>)=>void}
const recompute=internals.recompute.bind(graph)
internals.recompute=ids=>{recomputed+=ids.size;recompute(ids)}
graph.replace([500],[])
assert.ok(recomputed<20,'a read-list deletion does not recompute all thousand users')
assert.deepEqual(graph.context().nodes,createDependencyGraph(gates.filter((_,i)=>i!==500)))
const directory=await mkdtemp(join(tmpdir(),'packed-checkpoint-'))
const original=Array.from({length:100000},()=>({...cn}))
const writer=new CheckpointWriter(original,3,65),file=join(directory,'latest.json')
let ticks=0;const heartbeat=setInterval(()=>ticks++,1)
try{
 await writer.write([file],[])
 assert.ok(ticks>0,'main-thread timers run while a large checkpoint is verified')
 const idleWorker = Reflect.get(writer, 'worker')
 await idleWorker.terminate()
 await writer.write([file],[])
 assert.notEqual(Reflect.get(writer, 'worker'),idleWorker,'the next write replaces an exited idle worker')
 const before=await readFile(file,'utf8')
 await assert.rejects(writer.write([file],[{a:0,b:0,target:0,gate_i:15}]),/CORRUPTION/)
 await assert.rejects(writer.write([file],[{a:0,b:0,target:3,gate_i:15}]),/CORRUPTION: invalid gate.*checkpoint candidate/)
 await assert.rejects(writer.write([file],[{a:3,b:0,target:0,gate_i:0}]),/CORRUPTION: invalid gate.*checkpoint candidate/)
 assert.equal(await readFile(file,'utf8'),before,'failed verification never overwrites the saved circuit')
 await assert.rejects(writer.write([directory],[]),/EISDIR|EPERM|EACCES/)
 await writer.write([file],[])
 let persisted=0
 const checkpoint=new AsyncReductionCheckpoint(10,async()=>{persisted++;await new Promise(r=>setTimeout(r,5))})
 assert.deepEqual(await Promise.all([checkpoint.saveIfReduced([cn,cn]),checkpoint.saveIfReduced([cn,cn,cn])]),[true,false])
 assert.equal(persisted,1,'stale requests cannot regress the saved count')
 const simpler={a:0,b:0,target:0,gate_i:15}
 const tied=new AsyncReductionCheckpoint([cn],async()=>{})
 assert.deepEqual(await Promise.all([tied.saveIfReduced([simpler]),tied.saveIfReduced([cn])]),[true,false],'same-size checkpoints retain the simpler circuit')
 let fail=true
 const retry=new AsyncReductionCheckpoint(10,async()=>{if(fail)throw new Error('disk failure')})
 await assert.rejects(retry.saveIfReduced([]),/disk failure/);assert.equal(retry.hasSaved,false)
 fail=false;assert.equal(await retry.saveIfReduced([]),true,'failed writes do not advance the saved count')
}finally{clearInterval(heartbeat);await writer.close();await rm(directory,{recursive:true,force:true})}

const proofDir = await mkdtemp(join(tmpdir(),'exact-checkpoint-'))
const flip = {a:4,b:5,target:6,gate_i:1}, left = {a:0,b:1,target:4,gate_i:1}, right = {a:2,b:3,target:5,gate_i:1}
const rareDifference = [flip,left,flip,right,flip,left,flip,right]
const narrow = new CheckpointWriter(rareDifference,64,1)
try {
 const path = join(proofDir, 'latest.json')
 const fixture = JSON.parse(await readFile(new URL('../proofs/nonlinear-basis-maze-corruption.json', import.meta.url), 'utf8'))
 const circuit = (gates: [number, number, number, number][]) => ({ wire_count: 64, gate_count: gates.length, gates })
 const originalCircuit = circuit(fixture.before), inputCircuit = circuit(fixture.incorrect_after)
 const puzzle = join(proofDir, 'wide-resume')
 let initialized = false
 await assert.rejects(splitTaskAndRun(puzzle, puzzle, { originalCircuit, inputCircuit }, undefined, async () => {
  initialized = true
 }), /CORRUPTION: checkpoint differs/)
 assert.equal(initialized, false)
 await assert.rejects(readFile(outputPaths(puzzle).latest), { code: 'ENOENT' })
 const noOpPuzzle = join(proofDir, 'single-no-op')
 const noOpCircuit = circuit([[0, 0, 0, 6]])
 const originalNoOps = circuit([[0, 0, 0, 6], [0, 0, 0, 0]])
 const startupLog: string[] = []
 const log = console.log
 try {
  console.log = (...args: unknown[]) => { startupLog.push(args.join(' ')) }
  await splitTaskAndRun(noOpPuzzle, noOpPuzzle, { originalCircuit: originalNoOps, inputCircuit: noOpCircuit }, undefined, async () => {
   assert.fail('a single no-op should finish before initializing rainbow tables')
  })
 } finally { console.log = log }
 assert.ok(startupLog.some(line => line.includes('Circuit: 1G 0P | verifying input checkpoint')))
 assert.equal(JSON.parse(await readFile(outputPaths(noOpPuzzle).latest, 'utf8')).gate_count, 0)
 const wideGates = fixture.before.map(([a, b, target, gate_i]: number[]) => ({ a, b, target, gate_i }))
 const wide = new CheckpointWriter(wideGates, 64, 1)
 try {
  const not = { a: 0, b: 0, target: 63, gate_i: 15 }
  await wide.write([], [...wideGates, not, not], true)
 } finally { await wide.close() }
 const previousLimit = config.synthesis.affineMaximumTerms
 config.synthesis.affineMaximumTerms = 1
 const fallback = new CheckpointWriter(wideGates, 64, 1)
 const fallbackPath = join(proofDir, 'sampled.json')
 const not = { a: 0, b: 0, target: 63, gate_i: 15 }
 try {
  const result = await fallback.write([fallbackPath], [...wideGates, not, not], true)
  assert.equal(result.sampledResumeInputs, 1024)
  const saved = await readFile(fallbackPath, 'utf8')
  await assert.rejects(fallback.write([fallbackPath], [...wideGates, not], true), /CORRUPTION: checkpoint differs/)
  assert.equal(await readFile(fallbackPath, 'utf8'), saved)

  const identity = circuit(Array.from({ length: 9 }, (_, wire) => [[0, 0, wire, 15], [0, 0, wire, 15]] as [number, number, number, number][]).flat())
  const sampledPuzzle = join(proofDir, 'sampled-resume')
  const sampledLog: string[] = []
  try {
   console.log = (...args: unknown[]) => { sampledLog.push(args.join(' ')) }
   await splitTaskAndRun(sampledPuzzle, sampledPuzzle, { originalCircuit: identity, inputCircuit: circuit([]) })
  } finally { console.log = log }
  assert.ok(sampledLog.some(line => line.includes('Resuming after 1024 sampled inputs matched the original circuit')))
  assert.equal(JSON.parse(await readFile(outputPaths(sampledPuzzle).latest, 'utf8')).gate_count, 0)
 } finally {
  await fallback.close()
  config.synthesis.affineMaximumTerms = previousLimit
 }
 await narrow.write([path],rareDifference)
 const savedProof = await readFile(path,'utf8')
 await assert.rejects(narrow.write([path],[]),/CORRUPTION/)
 assert.equal(await readFile(path,'utf8'),savedProof)
} finally {
 await narrow.close()
 await rm(proofDir,{recursive:true,force:true})
}
const t={a:0,b:1,target:2,gate_i:1},cx={a:3,b:0,target:4,gate_i:3}
const distributed=[t,cx,{a:2,b:4,target:5,gate_i:1},cx,{a:2,b:3,target:5,gate_i:1},{a:2,b:4,target:5,gate_i:1},t]
const options={maximumWires:64,maximumNodes:200000,maximumEdges:16000000,stopped:()=>false}
const api=await init()
try{
 const a:SweepStats={queries:0,merges:0,counterexamples:0},b:SweepStats={queries:0,merges:0,counterexamples:0}
 assert.deepEqual(await sweepFactored(distributed,options,performance.now()+30000,a,api),[])
 assert.deepEqual(await sweepFactored(distributed,options,performance.now()+30000,b,api),[])
 assert.equal(a.contextInitializations,1);assert.equal(b.contextInitializations,undefined)
 assert.equal(await sweepFactored([t],{...options,simulationBits:1},performance.now()+30000,undefined,api),undefined,'fresh solvers do not inherit previous miters or lemmas')
}finally{await killThreads(api.em)}
console.log('Profile optimizations: nonqueued SAT, context reuse, sparse graph edits, background packed checkpoints, corruption rejection and ordered persistence passed')
