import assert from 'node:assert/strict'
import { formatRoundStrategies, WorkerActivity } from './logging.js'
const assignment = (workerId: number, activeStrategy: string): WorkerActivity => ({
	workerId, activeStrategy, passes: 1, subsets: 1, checks: 1, improvements: 0, stage: 'searching',
})
assert.equal(formatRoundStrategies([
	assignment(1, 'rainbow'), assignment(1, 'rainbow'), assignment(2, 'rainbow'),
	assignment(3, 'rainbow'), assignment(4, 'rainbow'), assignment(5, 'sat-sweeping'),
]), 'Round strategies: rainbow:4, SAT sweep:1')
assert.equal(formatRoundStrategies([]), undefined)
