import assert from 'node:assert/strict'
import { StrategySummary, StrategyWeightSummary, formatStrategyWeights, WorkerStatus } from './logging.js'
import { StrategyStat } from './strategy-stats.js'
const stat = (strategy: string, settings: string, attempts: number, elapsedMs: number): StrategyStat => ({ strategy, settings, attempts, elapsedMs, rewrites: 0, gatesRemoved: 0 })
const summary = new StrategySummary()
const first = [stat('rainbow', 'slice2', 2, 20), stat('rainbow', 'slice3', 1, 30), stat('gf2-affine-whole', '', 1, 10)]
summary.observe(1, first)
summary.observe(1, first)
summary.observe(2, [stat('z3', '', 1, 100)])
assert.equal(summary.flush(), 'Tried (worker time): Z3 1x/0.10s, rainbow 3x/0.05s, GF2 broad 1x/0.01s')
summary.observe(1, first)
assert.equal(summary.flush(), undefined, 'cumulative repeated reports must not count twice across intervals')
summary.observe(1, [stat('rainbow', 'slice2', 3, 40), first[1], first[2]])
summary.finish(1)
summary.finish(2)
summary.observe(3, [stat('rainbow', 'slice2', 1, 10)])
assert.equal(summary.flush(), 'Tried (worker time): rainbow 2x/0.03s', 'retain interval deltas across job and round restarts')
summary.finish(3)
assert.equal(summary.flush(), undefined)
console.log('Compact strategy summaries: settings aggregation, interval deltas, repeated snapshots and restarted jobs passed')

const policy = (workerId: number, updatedAtMs: number, weight: number, scope?: 'broad'): WorkerStatus => ({ updatedAtMs, done: true, activity: { workerId, scope, passes: 1, subsets: 1, checks: 1, improvements: 1, stage: 'verifying', strategyWeights: [{ strategy: 'rainbow', weight, attempts: 1 }, { strategy: 'variables', weight: 1, attempts: 0 }] } })
assert.deepEqual(formatStrategyWeights([policy(1, 1, 9), policy(1, 2, 3), policy(2, 1, 1), policy(1, 3, 5, 'broad')]), [
	'Strategy weights (local): rainbow 2.00x',
	'Strategy weights (broad): rainbow 5.00x',
], 'use each persistent worker once per scope, taking its most recent job')
assert.deepEqual(formatStrategyWeights([]), [])
assert.deepEqual(formatStrategyWeights([{ updatedAtMs: 1, done: true }]), [])
const weightSummary = new StrategyWeightSummary()
weightSummary.observe(policy(1, 1, 9).activity)
weightSummary.observe(undefined)
weightSummary.observe(policy(1, 2, 3).activity)
weightSummary.observe(policy(2, 1, 1).activity)
assert.deepEqual(weightSummary.format(), ['Strategy weights (local): rainbow 2.00x'])
assert.deepEqual(weightSummary.format(), ['Strategy weights (local): rainbow 2.00x'], 'retain weights across summary intervals and round restarts')
console.log('Round strategy weights: worker deduplication, latest snapshots, separate broad policies and missing reports passed')
