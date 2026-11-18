import { Gate } from './types.js'

/** One retained version: exact equality, bounded independently of job count. */
export class SearchProgress {
 private input: Gate[] = []
 private key = ''
 private iterator?: Generator<{start:number,end:number}>
 private pending?: {start:number,end:number,slice:number}
 reset(input: Gate[], regions: () => Generator<{start:number,end:number}>) {
  const key = JSON.stringify(input)
  if (key === this.key && this.iterator) return
  let first = 0
  while (first < input.length && first < this.input.length && JSON.stringify(input[first]) === JSON.stringify(this.input[first])) first++
  const changed = this.input.length > 0 && first < input.length
  const priorities = changed ? [32,128,512,2048].map(width => ({start:Math.max(0,first-width),end:Math.min(input.length,first+width)})) : []
  this.iterator = (function*(){ yield* priorities; yield* regions() })()
  this.key = key; this.input = input.slice(); this.pending = undefined
 }
 next(minimum: number) {
  if (!this.pending) {
   const region = this.iterator?.next()
   if (!region || region.done) { this.iterator = undefined; return undefined }
   this.pending = {...region.value,slice:region.value.end-region.value.start}
  }
  const result = {...this.pending}
  this.pending.slice = Math.floor(this.pending.slice/2)
  if (this.pending.slice < minimum) this.pending = undefined
  return result
 }
}
