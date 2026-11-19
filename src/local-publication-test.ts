import assert from 'node:assert/strict'
import sqlite3 from 'sqlite3'
import {config} from './config.js'
import {optimize} from './processing.js'
import {RainbowPortfolio} from './rainbow-portfolio.js'
import {runSQL} from './sql.js'
import {functionKey,encodeGates} from './semantic.js'
const saved=structuredClone(config), previousRandom=Math.random
const db=new sqlite3.Database(':memory:'), tables=new RainbowPortfolio([{wires:3,gates:1,db}])
try{
 config.search.strategyAdaptive=false;config.search.variableElimination=false;config.search.probabilistic=false
 Object.assign(config.search,{subsetMinimum:2,subsetMaximum:2,sliceMinimum:2,sliceMaximum:2,workerShufflePasses:1})
 Object.assign(config.synthesis,{templates:false,affine:false,quadratic:false,factored:false,blockCancellation:false,satSweeping:false,forwardSemanticSearch:false,smt:false,meetInMiddle:false,equalitySaturation:false})
 config.timing.workerReportSeconds=60
 await runSQL(db,'CREATE TABLE InputOutputReplacers(ioIdentifier BLOB PRIMARY KEY,replacerGates BLOB NOT NULL) WITHOUT ROWID')
 await runSQL(db,'INSERT INTO InputOutputReplacers VALUES (?,?)',[Buffer.from(functionKey([],3),'hex'),encodeGates([])])
 const cn={a:0,b:0,target:1,gate_i:3}, input=[cn,cn,cn]
 let published=false, continued=false
 const result=await optimize(tables,input,3,'publication',true,undefined,100, (count,_activity,candidate)=>{
  if(count<input.length && candidate){published=true;assert.equal(candidate.length,count)}
 },()=>{if(published)continued=true;return published},count=>count<input.length,true)
 assert.ok(published && continued,'publish a reduction before stopping checks or job completion')
 assert.equal(result.length,1)

 Object.assign(config.search,{maximumInnerChunks:3,minimumInnerChunkGates:2})
 const splitInput=Array.from({length:6},()=>cn)
 let lastPublished=splitInput.length
 const earlySnapshots:number[]=[]
 const splitResult=await optimize(tables,splitInput,3,'coalesced publication',true,undefined,500,(count,activity,candidate)=>{
  if(candidate && count<lastPublished){
   if(activity.stage==='searching')earlySnapshots.push(count)
   lastPublished=count
  }
 },activity=>(activity?.improvements??0)>=3,count=>count<lastPublished,true)
 assert.deepEqual(earlySnapshots,[4],'publish only the first improvement before the periodic report')
 assert.deepEqual(splitResult,[],'retain later improvements for the final result')

 Object.assign(config.search,{subsetMinimum:10,subsetMaximum:10,workerShufflePasses:4})
 Math.random=()=>0.75
 const shuffleInput=[cn,{a:0,b:0,target:2,gate_i:15},cn]
 let shuffleChecks=0
 const stopped=await optimize(tables,shuffleInput,3,'cancel shuffle',true,undefined,500,undefined,activity=>
  activity?.stage==='shuffling' && ++shuffleChecks>=2
 )
 assert.deepEqual(stopped,shuffleInput,'honor cancellation inside the shuffle before swapping any gates')
}finally{Math.random=previousRandom;Object.assign(config,saved);await tables.close()}
console.log('Local progress publishes the first improvement promptly, coalesces later improvements and stops shuffling on cancellation')
