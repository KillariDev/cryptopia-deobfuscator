import assert from 'node:assert/strict'
import sqlite3 from 'sqlite3'
import {config} from './config.js'
import {optimize} from './processing.js'
import {RainbowPortfolio} from './rainbow-portfolio.js'
const saved=structuredClone(config)
const tables=new RainbowPortfolio([{wires:3,gates:1,db:new sqlite3.Database(':memory:')}])
let waiting=false,reportsWhileWaiting=0
try{
 config.timing.workerReportSeconds=0.01;config.search.strategyAdaptive=false
 Object.assign(config.search,{probabilistic:false,variableElimination:false,subsetMinimum:2,subsetMaximum:3,sliceMinimum:2,sliceMaximum:2,workerShufflePasses:1})
 Object.assign(config.synthesis,{affine:false,quadratic:false,factored:false,blockCancellation:false,satSweeping:false,forwardSemanticSearch:false,smt:false,meetInMiddle:false,equalitySaturation:false})
 tables.findReplacements=async()=>{waiting=true;await new Promise(resolve=>setTimeout(resolve,80));waiting=false;return new Map()}
 const gates=Array.from({length:20},()=>({a:0,b:0,target:1,gate_i:3}))
 await optimize(tables,gates,3,'heartbeat',true,undefined,100,()=>{if(waiting)reportsWhileWaiting++})
 assert.ok(reportsWhileWaiting>=2,'asynchronous solver waits still send live progress')
 const count=reportsWhileWaiting
 await new Promise(resolve=>setTimeout(resolve,40))
 assert.equal(reportsWhileWaiting,count,'job completion removes heartbeat timers')
}finally{Object.assign(config,saved);await tables.close()}
console.log('Worker heartbeats continue through asynchronous strategy waits and clean up on completion')
