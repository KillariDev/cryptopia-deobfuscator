import { Worker } from 'node:worker_threads'
import { Gate } from './types.js'

/** Disposable isolate: cancellation releases both WASM memory and helper threads. */
export function runSolverWorker(url: URL, data: object, budgetMs: number, shouldStop: () => boolean): Promise<Gate[] | undefined> {
	if (shouldStop() || budgetMs <= 0) return Promise.resolve(undefined)
	return new Promise((resolve, reject) => {
		const worker = new Worker(url, { workerData: data })
		let settled = false
		let deadline: ReturnType<typeof setTimeout> | undefined, stop: ReturnType<typeof setInterval> | undefined
		const finish = (result?: Gate[], error?: Error) => {
			if (settled) return
			settled = true; clearTimeout(deadline); clearInterval(stop)
			void worker.terminate().then(() => error ? reject(error) : resolve(result), reject)
		}
		deadline = setTimeout(() => finish(), budgetMs)
		stop = setInterval(() => { if (shouldStop()) finish() }, 10)
		worker.once('message', (message: { result?: Gate[], error?: string }) => finish(message.result, message.error === undefined ? undefined : new Error(message.error)))
		worker.once('error', error => finish(undefined, error))
		worker.once('exit', code => { if (!settled) finish(undefined, new Error(`Solver worker exited without a result (${code})`)) })
	})
}

/** A serial SAT service retains its engine between calls. Cancellation or
 * periodic recycling still releases the entire isolate and native helpers. */
export class SolverService {
 private worker?: Worker
 private calls = 0
 private active = false
 get busy() { return this.active }
 run(url: URL, data: object, budgetMs: number, shouldStop: () => boolean) {
  if (this.active) return Promise.resolve(undefined)
  this.active = true
  return this.execute(url, data, budgetMs, shouldStop).finally(() => { this.active = false })
 }
 private async execute(url: URL, data: object, budgetMs: number, shouldStop: () => boolean): Promise<Gate[] | undefined> {
  if(shouldStop() || budgetMs<=0)return undefined
  if(this.calls>=32){await this.worker?.terminate();this.worker=undefined;this.calls=0}
  const worker=this.worker ??= new Worker(url,{workerData:{service:true}})
  this.calls++;worker.ref()
  return new Promise((resolve,reject)=>{
   let done=false
   const finish=(result?:Gate[],error?:Error,retire=false)=>{
    if(done)return;done=true;clearTimeout(timer);clearInterval(poll)
    worker.removeListener('message',message);worker.removeListener('error',failure);worker.removeListener('exit',exit)
    if(retire){this.worker=undefined;void worker.terminate().then(()=>error?reject(error):resolve(result),reject)}
    else{worker.unref();error?reject(error):resolve(result)}
   }
   const message=(value:{result?:Gate[],error?:string})=>finish(value.result,value.error?new Error(value.error):undefined,!!value.error)
   const failure=(error:Error)=>finish(undefined,error,true)
   const exit=(code:number)=>failure(new Error(`SAT service exited (${code})`))
   const timer=setTimeout(()=>finish(undefined,undefined,true),budgetMs)
   const poll=setInterval(()=>{if(shouldStop())finish(undefined,undefined,true)},10)
   worker.once('message',message);worker.once('error',failure);worker.once('exit',exit)
   worker.postMessage(data)
  })
 }
}
