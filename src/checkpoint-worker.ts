import {parentPort,workerData} from 'node:worker_threads'
import {IncrementalEvaluator} from './packed.js'
import {generateNRandomBooleanArray,simplifyGate} from './utils.js'
import {mkdirSync,writeFileSync,renameSync,rmSync} from 'node:fs'
import {dirname} from 'node:path'
import {threadId} from 'node:worker_threads'
import {convertToOriginal} from './utils.js'
import {Gate} from './types.js'
const {original,wires,checks}=workerData as {original:Gate[],wires:number,checks:number}
parentPort!.on('message',({gates,filenames}:{gates:Gate[],filenames:string[]})=>{
 try{
  const normalized=gates.map(simplifyGate)
  const inputs=generateNRandomBooleanArray(checks,wires)
  const evaluator=new IncrementalEvaluator(original,inputs,0,1)
  if(!evaluator.equivalent(normalized))throw new Error('CORRUPTION: checkpoint differs from original circuit')
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
