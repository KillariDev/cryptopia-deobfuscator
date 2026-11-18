import assert from 'node:assert/strict'
import {mkdtemp,rm} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {config} from './config.js'
import {WorkerPool} from './threads.js'
import {splitTaskAndRun} from './processing.js'
const saved=structuredClone(config),run=WorkerPool.prototype.run,log=console.log
const dir=await mkdtemp(join(tmpdir(),'local-global-'))
const done=new Error('verified round')
const circuit={wire_count:2,gate_count:5001,gates:Array.from({length:5001},()=>[0,0,0,15] as [number,number,number,number])}
try{
 config.files.dataDirectory=dir;config.database.sharedTables=false;config.logging.verbose=false;console.log=()=>{}
 Object.assign(config.workers,{maximum:4,keepBusy:true,jobsPerWorker:1,broadSearchIdleSeconds:0,broadSearchSeconds:1})
 let localSignal:SharedArrayBuffer|undefined,globalSignal:SharedArrayBuffer|undefined,proved=false
 WorkerPool.prototype.run=async function(gates,wires,progress,signal,budget,restart,solver){
  if(solver==='broad'){
   globalSignal=signal
   assert.notEqual(globalSignal,localSignal)
   while(!Atomics.load(new Int32Array(signal!),0))await new Promise(resolve=>setTimeout(resolve,1))
   return gates
  }
  if(localSignal && localSignal!==signal)throw done
  localSignal=signal
  assert.equal(restart,false,'local jobs keep searching after a win')
  if(!proved){
   proved=true
   progress?.(gates.length-2,undefined,gates.slice(2))
   assert.equal(Atomics.load(new Int32Array(localSignal!),0),0,'local win leaves local peers running')
   assert.equal(Atomics.load(new Int32Array(globalSignal!),0),1,'local win cancels global job')
   Atomics.store(new Int32Array(localSignal!),0,1)
  }
  return gates
 }
 await assert.rejects(splitTaskAndRun(join(dir,'restart'),'unused',{originalCircuit:circuit,inputCircuit:circuit}),error=>error===done)
 assert.ok(proved)
 let first:SharedArrayBuffer|undefined,broad=0
 config.workers.broadSearchIdleSeconds=60
 WorkerPool.prototype.run=async function(gates,wires,progress,signal,budget,restart,solver){
  if(solver==='broad'){broad++;throw new Error('global started before idle')}
  if(first && first!==signal)throw done
  first=signal;Atomics.store(new Int32Array(signal!),0,1);return gates
 }
 await assert.rejects(splitTaskAndRun(join(dir,'idle'),'unused',{originalCircuit:circuit,inputCircuit:circuit}),error=>error===done)
 assert.equal(broad,0,'global work waits for an idle period')
}finally{Object.assign(config,saved);WorkerPool.prototype.run=run;console.log=log;await rm(dir,{recursive:true,force:true})}
console.log('Local wins retain peers, cancel global work independently, and idle gating defers global searches passed')
