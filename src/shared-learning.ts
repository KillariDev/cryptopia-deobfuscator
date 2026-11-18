import { isMainThread, workerData } from 'node:worker_threads'
export const learningNames = ['templates','variables','rainbow','gf2-affine','quadratic','factored','block-cancellation','sat-sweeping','forward-semantic-search','z3','meet-in-the-middle','equality-saturation','symbolic','dependency-cuts']
// Minute buckets bound memory and let old evidence expire across all workers.
const buckets = 8, stride = 4
export const learningBytes = learningNames.length * buckets * stride * 4
export class SharedLearning {
 private data: Int32Array
 constructor(buffer: SharedArrayBuffer, private clock = Date.now) { this.data = new Int32Array(buffer) }
 observe(name: string, removed: number, elapsed: number) {
  const index = learningNames.indexOf(name); if(index < 0) return
  const minute = Math.floor(this.clock()/60000), base=(index*buckets+minute%buckets)*stride
  // A per-bucket lock prevents reset/write races at minute boundaries.
  if(Atomics.compareExchange(this.data,base,0,1)!==0)return
  try {
   if(this.data[base+1]!==minute){this.data[base+1]=minute;this.data[base+2]=0;this.data[base+3]=0}
   this.data[base+2]=Math.min(2147483647,this.data[base+2]+Math.max(0,Math.floor(removed)))
   this.data[base+3]=Math.min(2147483647,this.data[base+3]+Math.max(1,Math.ceil(elapsed)))
  }finally{Atomics.store(this.data,base,0)}
 }
 rate(name: string, halfLife: number) {
  const index=learningNames.indexOf(name); if(index<0)return undefined
  const minute=Math.floor(this.clock()/60000);let gates=0,time=0
  for(let b=0;b<buckets;b++){
   const base=(index*buckets+b)*stride
   if(Atomics.compareExchange(this.data,base,0,1)!==0)continue
   try{const age=minute-this.data[base+1];if(age>=0&&age<buckets){const decay=2**(-age*60/halfLife);gates+=this.data[base+2]*decay;time+=this.data[base+3]}}
   finally{Atomics.store(this.data,base,0)}
  }
  return time ? gates*1000/time : undefined
 }
}
export const workerLearning = !isMainThread && workerData?.strategyLearning ? new SharedLearning(workerData.strategyLearning) : undefined
