import assert from 'node:assert/strict'
import { MemoryConcurrency, memorySnapshot } from './concurrency.js'
import { WorkerPool } from './threads.js'

const guard = new MemoryConcurrency(8)
assert.equal(guard.limit(8), 8)
assert.equal(guard.observe(0, 0.2, 8), undefined)
assert.equal(guard.observe(0, 0.95, 8), 4)
assert.equal(guard.observe(1000, 1.1, 4), undefined)
assert.equal(guard.observe(2000, 1.1, 4), 2)
assert.equal(guard.limit(8), 2)
assert.equal(guard.observe(4000, 0.4, 2), 3)
assert.equal(guard.limit(1), 1)
assert.equal(guard.observe(4500, 0.4, 3), undefined)
const startup = new MemoryConcurrency(24, 4)
assert.equal(startup.limit(24), 4)
assert.equal(startup.observe(0, 0.2, 4), 5)
assert.equal(startup.observe(500, 0.2, 5), undefined)
assert.equal(startup.observe(2000, 0.95, 5), 2)
const memory = memorySnapshot(8192)
assert.ok(memory.rss > 0 && memory.budget > 0 && memory.free >= 0)

const fixture = new URL('data:text/javascript,' + encodeURIComponent(`
import {parentPort} from 'node:worker_threads';
parentPort.on('message', async ({gates}) => {
 parentPort.postMessage({progress:gates.length});
 await new Promise(resolve=>setTimeout(resolve,100));
 parentPort.postMessage({gates});
});`))
const pool = new WorkerPool(3, fixture)
let started = 0, release!: () => void
const ready = new Promise<void>(resolve => { release = resolve })
const gate = { a: 0, b: 0, target: 0, gate_i: 0 }
try {
	const work = [1, 2, 3].map(length => pool.run(Array.from({ length }, () => gate), 1, () => { if (++started === 3) release() }))
	await ready
	await pool.trimForMemory(1)
	const queued = pool.run([gate], 1)
	assert.deepEqual((await Promise.all(work)).map(result => result.length), [1, 2, 3])
	assert.deepEqual(await queued, [gate])
	assert.equal((pool as unknown as { slots: unknown[] }).slots.length, 1)
} finally { await pool.close() }
console.log('Memory ceiling: full capacity below pressure, prompt isolate retirement, safe seed results, bounded recovery and continued queued work passed')
