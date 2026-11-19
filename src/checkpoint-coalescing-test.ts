import assert from 'node:assert/strict'
import {mkdtemp,readFile,readdir,rm} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {config} from './config.js'
import {WorkerPool} from './threads.js'
import {splitTaskAndRun} from './processing.js'
const saved=structuredClone(config),run=WorkerPool.prototype.run,log=console.log
const dir=await mkdtemp(join(tmpdir(),'checkpoint-coalesce-')),done=new Error('round complete')
try{
 config.files.dataDirectory=dir;config.database.sharedTables=false;config.logging.verbose=false;console.log=()=>{}
 Object.assign(config.workers,{maximum:1,keepBusy:true,jobsPerWorker:1,broadSearchSeconds:0})
 assert.equal(config.timing.checkpointSeconds,30)
 config.timing.checkpointSeconds=60
 let first:SharedArrayBuffer|undefined,emitted=0
 WorkerPool.prototype.run=async function(gates,wires,progress,signal){
  if(first && first!==signal)throw done
  first=signal
  if(!emitted){
   for(let i=1;i<=40;i++){progress?.(gates.length-2*i,undefined,gates.slice(2*i));emitted++}
   Atomics.store(new Int32Array(signal!),0,1)
   return gates.slice(80)
  }
  return gates
 }
 const circuit={wire_count:2,gate_count:5001,gates:Array.from({length:5001},()=>[0,0,0,15] as [number,number,number,number])}
 await assert.rejects(splitTaskAndRun(join(dir,'puzzle'),'unused',{originalCircuit:circuit,inputCircuit:circuit}),e=>e===done)
 assert.equal(emitted,40)
 assert.equal((await readdir(join(dir,'puzzle-progress'))).filter(file=>file.endsWith('.json')).length,1,'a burst of local wins produces one final checkpoint')
 assert.equal(JSON.parse(await readFile(join(dir,'puzzle-latest.json'),'utf8')).gate_count,4921,'the latest reduction is retained at round end')
 const tied = { wire_count: 2, gate_count: 4, gates: Array.from({length: 4}, () => [0, 0, 1, 3] as [number,number,number,number]) }
 const tiedPath = join(dir,'tied')
 const controlFree = Array.from({length: 4}, () => ({a:0,b:0,target:1,gate_i:15}))
 first = undefined
 WorkerPool.prototype.run=async function(gates,_wires,progress,signal){
  if(first && first!==signal)throw done
  first=signal
  progress?.(gates.length,undefined,controlFree)
  Atomics.store(new Int32Array(signal!),0,1)
  return gates
 }
 await assert.rejects(splitTaskAndRun(tiedPath,'unused',{originalCircuit:tied,inputCircuit:tied}),e=>e===done)
 const tiedCheckpoint = JSON.parse(await readFile(tiedPath+'-latest.json','utf8'))
 assert.equal(tiedCheckpoint.gate_count, 4)
 assert.ok(tiedCheckpoint.gates.every((gate: number[]) => gate[3] === 15), 'persist a same-size circuit that drops an active wire')

}finally{WorkerPool.prototype.run=run;Object.assign(config,saved);console.log=log;await rm(dir,{recursive:true,force:true})}
console.log('Checkpoint coalescing retains the latest of forty local updates without forty verification/write cycles')
