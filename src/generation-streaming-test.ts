import assert from 'node:assert/strict'
import { setImmediate as immediate } from 'node:timers/promises'
import { GenerationCandidateCache } from './generation-candidate-cache.js'
import { GenerationStagingStream } from './generation-staging-stream.js'
import { StagingRow } from './generation-staging.js'
import { parseConfig } from './config.js'

// A one-entry cache forces every different key to collide. No collision may
// reject a new key or lose the first cheapest payload kept by SQL.
for (const budget of [0, 8, 9, 64, 4096]) {
	const cache = new GenerationCandidateCache(3, budget)
	assert.ok(cache.bytes <= budget)
	const expected = new Map<string, [number, number]>(), actual = new Map<string, [number, number]>()
	for (let depth = 0; depth < 3; depth++) {
		cache.beginDepth(depth)
		for (let i = 0; i < 5000; i++) {
			const state = Buffer.from([i % 11, i % 7, i % 3]), mask = i % 4, reads = i % 17 === 0 ? 0xffffffff : i * 31 % 29
			const key = `${depth}:${state.toString('hex')}:${mask}`
			const update = (map: Map<string, [number, number]>) => { if (!map.has(key) || reads < map.get(key)![0]) map.set(key, [reads, i]) }
			update(expected)
			if (cache.accept(state, mask, reads)) update(actual)
		}
	}
	assert.deepEqual(actual, expected)
}
const cache = new GenerationCandidateCache(2, 8)
cache.beginDepth(1)
const state = Buffer.from([1,2])
assert.equal(cache.accept(state, 1, 10), true)
state[0] = 99
assert.equal(cache.accept(Buffer.from([1,2]), 1, 10), false, 'retained keys copy caller memory')
assert.equal(cache.accept(Buffer.from([1,2]), 1, 9), true)
assert.equal(cache.accept(Buffer.from([1,2]), 2, 9), true, 'masks are part of the exact key')
cache.beginDepth(2)
assert.equal(cache.accept(Buffer.from([1,2]), 2, 9), true, 'depth changes discard dominance history')
assert.throws(() => cache.accept(Buffer.from([1,2]), 256, 1), /Invalid/)
assert.throws(() => cache.accept(Buffer.from([1,2]), 1, -1), /Invalid/)

// Final-layer masks need no future continuation. Strictly better wire/read
// costs dominate other masks; equal-cost different masks retain SQL tie choices.
const finalCache = new GenerationCandidateCache(1, 64)
finalCache.beginDepth(2, true)
assert.equal(finalCache.accept(Buffer.from([7]), 3, 9), true)
assert.equal(finalCache.accept(Buffer.from([7]), 5, 10), false)
assert.equal(finalCache.accept(Buffer.from([7]), 1, 20), true)
assert.equal(finalCache.accept(Buffer.from([7]), 3, 1), false)
assert.equal(finalCache.accept(Buffer.from([7]), 2, 20), true)
finalCache.beginDepth(2, false)
assert.equal(finalCache.accept(Buffer.from([7]), 3, 1), true)
assert.equal(finalCache.accept(Buffer.from([7]), 1, 20), true)

const row = (id: number): StagingRow[] => [[Buffer.from([id]), 1, id, Buffer.from([id]), 1]]
let release!: () => void
const order: number[] = []
const stream = new GenerationStagingStream(2, async rows => {
	order.push(rows[0][2])
	if (rows[0][2] === 1) await new Promise<void>(resolve => { release = resolve })
})
await stream.submit(row(1)); await stream.submit(row(2))
let admitted = false
const third = stream.submit(row(3)).then(() => { admitted = true })
await immediate(); assert.equal(admitted, false); assert.equal(stream.batches, 2)
release(); await third; await stream.finish()
assert.deepEqual(order, [1,2,3]); assert.equal(stream.peakBatches, 2); assert.equal(stream.batches, 0)
await assert.rejects(stream.submit(row(4)), /closed/)

let finishNative!: () => void, aborted = false
const consumed: number[] = []
const cancelled = new GenerationStagingStream(2, async rows => { consumed.push(rows[0][2]); await new Promise<void>(resolve => { finishNative = resolve }) })
await cancelled.submit(row(1)); await cancelled.submit(row(2))
const rejected = assert.rejects(cancelled.submit(row(3)), /closed/)
const abort = cancelled.abort().then(() => { aborted = true })
await immediate(); assert.equal(aborted, false, 'abort waits for the active native write')
finishNative(); await abort; await rejected
assert.deepEqual(consumed, [1], 'queued writes never run after cancellation')
await cancelled.abort()

const failed = new GenerationStagingStream(2, async () => { throw new Error('write failed') })
await failed.submit(row(1)); await immediate()
await assert.rejects(failed.finish(), /write failed/)
await assert.rejects(failed.submit(row(2)), /write failed/)
await failed.abort()
const synchronous = new GenerationStagingStream(1, () => { throw new Error('sync failed') })
await synchronous.submit(row(1)); await assert.rejects(synchronous.finish(), /sync failed/); await synchronous.abort()
assert.throws(() => new GenerationStagingStream(0, async () => {}))
assert.throws(() => parseConfig({ database: { generationCandidateCacheMegabytes: 1025 } }))
assert.equal(parseConfig({ database: { generationCandidateCacheMegabytes: 0 } }).database.generationCandidateCacheMegabytes, 0)
console.log('Exact bounded cache dominance/collisions and ordered staging streaming/backpressure/drain/failure checks passed')
