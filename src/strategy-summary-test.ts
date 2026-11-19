import assert from 'node:assert/strict'
import { formatRoundStrategies, WorkerActivity } from './logging.js'
const assignment = (workerId: number, activeStrategy: string): WorkerActivity => ({
	workerId, activeStrategy, passes: 1, subsets: 1, checks: 1, improvements: 0, stage: 'searching',
})
assert.equal(formatRoundStrategies([
	assignment(1, 'truth-table-lookup'), assignment(1, 'truth-table-lookup'), assignment(2, 'truth-table-lookup'),
	assignment(3, 'truth-table-lookup'), assignment(4, 'truth-table-lookup'), assignment(5, 'sat-sweeping'),
]), 'Round strategies: truth-table-lookup:4, SAT sweep:1')
assert.equal(formatRoundStrategies([]), undefined)
