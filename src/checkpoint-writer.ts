import {Worker} from 'node:worker_threads'
import {Gate} from './types.js'
import {config} from './config.js'
/** Original circuit stays resident in one background isolate. Requests serialize;
 * callers coalesce local wins before submitting a snapshot. */
export class CheckpointWriter {
 private worker?:Worker
 private tail:Promise<unknown>=Promise.resolve()
 constructor(private original:Gate[],private wires:number,private checks:number){}
 write(filenames:string[],gates:Gate[],requireExact=false) {
  const work=this.tail.then(()=>this.submit(filenames,gates,requireExact))
  this.tail=work.catch(()=>{})
  return work
 }
 private getWorker() {
  if (this.worker && this.worker.threadId !== -1) return this.worker
  const worker = new Worker(new URL('./checkpoint-worker.js', import.meta.url), {
   workerData: {original:this.original,wires:this.wires,checks:this.checks,solverConfig:config},
  })
  const invalidate = () => { if (this.worker === worker) this.worker = undefined }
  worker.on('error', invalidate)
  worker.once('exit', invalidate)
  this.worker = worker
  return worker
 }
 private submit(filenames:string[],gates:Gate[],requireExact:boolean):Promise<void>{
  const worker = this.getWorker()
  worker.ref()
  return new Promise((resolve,reject)=>{
   const clean=()=>{worker.removeListener('message',message);worker.removeListener('error',error);worker.removeListener('exit',exit);worker.unref()}
   const error=(error:Error)=>{clean();reject(error)}
   const exit=(code:number)=>error(new Error(`Checkpoint worker exited (${code})`))
   const message=(value:{error?:string})=>{clean();value.error?reject(new Error(value.error)):resolve()}
   worker.once('message',message);worker.once('error',error);worker.once('exit',exit)
   try{worker.postMessage({filenames,gates,requireExact})}catch(cause){error(cause as Error)}
  })
 }
 async close(){await this.tail;await this.worker?.terminate();this.worker=undefined}
}
