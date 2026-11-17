import assert from 'node:assert/strict'
import { GenerationPrefetch } from './generation-prefetch.js'
const immediate = () => new Promise<void>(resolve => setImmediate(resolve))
let produced = 0, closed = false
async function* source() { try { for (let id = 0; id < 12; id++) { produced++; yield { id, waitMs: 0 } } } finally { closed = true } }
const prefetched = new GenerationPrefetch(source(), 2, () => 1)
await immediate()
assert.ok(produced >= 2, 'independent work progresses before the consumer is ready')
assert.ok(prefetched.bufferedBytes <= 2)
const values = []
for await (const value of prefetched.values()) { values.push(value.id); await immediate() }
await prefetched.settled
assert.deepEqual(values, Array.from({ length: 12 }, (_, i) => i))
assert.ok(closed && prefetched.peakBytes <= 2)
const blocked = new GenerationPrefetch(source(), 1, () => 1)
await immediate(); blocked.cancel(); await blocked.settled
assert.equal(blocked.bufferedBytes, 0)
assert.equal((await blocked.values().next()).done, true)
const oversized = new GenerationPrefetch(source(), 1, () => 10)
for await (const value of oversized.values()) assert.ok(value.waitMs >= 0)
assert.equal(oversized.peakBytes, 10, 'oversize allowance is one chunk, not an unbounded queue')
async function* fails() { yield { id: 0, waitMs: 0 }; throw new Error('prefetch failed') }
const failure = new GenerationPrefetch(fails(), 100, () => 1)
await failure.settled
await assert.rejects(failure.values().next(), /prefetch failed/)
assert.equal(failure.bufferedBytes, 0)
console.log('Bounded lookahead overlap, order, backpressure, cancellation and deferred failure checks passed')
