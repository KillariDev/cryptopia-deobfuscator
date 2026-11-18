import assert from 'node:assert/strict'
import { StrategySummary } from './logging.js'
import { StrategyStat } from './strategy-stats.js'
const stat = (strategy: string, settings: string, attempts: number, elapsedMs: number): StrategyStat => ({ strategy, settings, attempts, elapsedMs, rewrites: 0, gatesRemoved: 0 })
const summary = new StrategySummary()
const first = [stat('rainbow', 'slice2', 2, 20), stat('rainbow', 'slice3', 1, 30), stat('gf2-affine-whole', '', 1, 10)]
summary.observe(1, first)
summary.observe(1, first)
summary.observe(2, [stat('z3', '', 1, 100)])
assert.equal(summary.flush(), 'Tried (worker time): Z3 1x/0.10s, rainbow 3x/0.05s, GF2 broad 1x/0.01s')
summary.observe(1, first)
assert.equal(summary.flush(), 'Tried: no new strategy timings reported', 'cumulative repeated reports must not count twice across intervals')
summary.observe(1, [stat('rainbow', 'slice2', 3, 40), first[1], first[2]])
summary.finish(1)
summary.finish(2)
summary.observe(3, [stat('rainbow', 'slice2', 1, 10)])
assert.equal(summary.flush(), 'Tried (worker time): rainbow 2x/0.03s', 'retain interval deltas across job and round restarts')
summary.finish(3)
assert.equal(summary.flush(), 'Tried: no new strategy timings reported')
console.log('Compact strategy summaries: settings aggregation, interval deltas, repeated snapshots and restarted jobs passed')
