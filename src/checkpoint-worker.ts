import {parentPort,workerData} from 'node:worker_threads'
import {IncrementalEvaluator} from './packed.js'
import {generateCombinations,generateNRandomBooleanArray,getVars,mapCircuit,simplifyGate} from './utils.js'
import {mkdirSync,writeFileSync,renameSync,rmSync} from 'node:fs'
import {dirname} from 'node:path'
import {threadId} from 'node:worker_threads'
import {convertToOriginal} from './utils.js'
import {Gate} from './types.js'
import {isWireIndex} from './circuit-validation.js'
const {original,wires,checks}=workerData as {original:Gate[],wires:number,checks:number}
function validateGate(gate: Gate, index: number, source: string) {
 if (!gate || !isWireIndex(gate.a,wires) || !isWireIndex(gate.b,wires) ||
  !isWireIndex(gate.target,wires) || !isWireIndex(gate.gate_i,16)) {
  throw new Error(`CORRUPTION: invalid gate at index ${index} in ${source}`)
 }
}
const exhaustiveWireLimit = 8
function activeWires(gates: Gate[], used = new Set<number>()) {
 for (const gate of gates) {
  for (const wire of getVars(gate)) used.add(wire)
  if (used.size > exhaustiveWireLimit) break
 }
 return used
}
let originalWires: Set<number> | undefined
parentPort!.on('message',({gates,filenames}:{gates:Gate[],filenames:string[]})=>{
 try{
  if (!originalWires) {
   original.forEach((gate,index)=>validateGate(gate,index,'original circuit'))
   originalWires=activeWires(original)
  }
  const normalized=gates.map((gate,index)=>{
   validateGate(gate,index,'checkpoint candidate')
   return simplifyGate(gate)
  })
  const active=originalWires.size<=exhaustiveWireLimit ? activeWires(normalized,new Set(originalWires)) : originalWires
  const exhaustive=active.size<=exhaustiveWireLimit
  const mapping=exhaustive && active.size!==wires ? [...active].sort((a,b)=>a-b) : undefined
  const inputs=exhaustive ? generateCombinations(active.size) : generateNRandomBooleanArray(checks,wires)
  const evaluator=new IncrementalEvaluator(mapping ? mapCircuit(original,mapping) : original,inputs,0,1)
  if(!evaluator.equivalent(mapping ? mapCircuit(normalized,mapping) : normalized))throw new Error('CORRUPTION: checkpoint differs from original circuit')
  const payload=convertToOriginal(wires,normalized)
  for(const filename of new Set(filenames)){
   mkdirSync(dirname(filename),{recursive:true})
   const temporary=`${filename}.${process.pid}.${threadId}.tmp`
   try{writeFileSync(temporary,payload,'utf8');renameSync(temporary,filename)}
   finally{rmSync(temporary,{force:true})}
  }
  parentPort!.postMessage({ok:true})
 }catch(error){parentPort!.postMessage({error:String(error)})}
})
