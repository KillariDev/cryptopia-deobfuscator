import assert from 'node:assert/strict'
import sqlite3 from 'sqlite3'
import { WriterUtilization } from './generation-utilization.js'
import { diagnosticDelta, formatDiagnosticSample, GenerationDiagnostics } from './generation-diagnostics.js'
import { GenerationEstimator, GenerationProfile } from './generation-progress.js'
import { parseConfig } from './config.js'

// Two operations overlap for 30ms, but neither is active at the final snapshot.
let now = 0, finishA!: () => void, finishB!: () => void
const writers = new WriterUtilization(2, () => now)
const a = writers.measure(() => new Promise<void>(resolve => { finishA = resolve }))
now = 10
const b = writers.measure(() => new Promise<void>(resolve => { finishB = resolve }))
now = 30; assert.deepEqual(writers.snapshot(), { writerMs: 50, allBusyMs: 20 })
now = 40; finishA(); await a
now = 70; finishB(); await b
assert.deepEqual(writers.snapshot(), { writerMs: 100, allBusyMs: 30 })
now = 80; await assert.rejects(writers.measure(async () => { now = 90; throw new Error('writer failed') }), /writer failed/)
now = 100; assert.deepEqual(writers.snapshot(), { writerMs: 110, allBusyMs: 30 }, 'failed operations release their slot')

const base = { phase: 'between operations', at: 1000, cpu: { user: 0, system: 0 }, io: process.resourceUsage(), loop: { active: 0, idle: 0, utilization: 0 }, sql: { calls: 0, awaitMs: 0, nativeCalls: 0, nativeMs: 0, active: 0, oldestMs: 0, maxMs: 0 }, phases: [0, 0, 0, 0, 0, 0], writerMs: 20, allBusyMs: 0, committedParents: 100 }
const next = { ...base, at: 2000, phases: [0, 200, 100, 0, 0, 500], writerMs: 1220, allBusyMs: 400, committedParents: 350 }
const sample = diagnosticDelta(base, next, 0, 0, 24)
assert.equal(sample.averageWriters, 1.2); assert.equal(sample.allBusyFraction, .4); assert.equal(sample.parentsPerSecond, 250)
const text = formatDiagnosticSample(sample, { running: 0, queued: 0, lookaheadBatches: 0, bufferedBytes: 0, bufferLimitBytes: 0, stagingWriters: 2, activeStagingWriters: 0 }).join('\n')
assert.match(text, /utilization 60% of 2 slot\(s\), all busy 40% of interval/)
assert.match(text, /250.0 committed parents\/s/); assert.match(text, /scratch import 0.5s/)
assert.match(text, /snapshot between operations/); assert.doesNotMatch(text, /Staging writers 0\/2 active/)

// A finished phase never keeps accumulating time while the next batch is prepared.
const db = new sqlite3.Database(':memory:')
const diagnostics = new GenerationDiagnostics(db, 10, 0)
try {
	const profile: GenerationProfile = { phase: 'committing', phaseActive: false, phaseStarted: performance.now() - 10000, stagingMs: 0, dedupMs: 0, outputMs: 0, commitMs: 12, importMs: 7, committedParents: 100, elapsedMs: 0, expansionMs: 0, writeMs: 19, readMs: 0, waitMs: 0, candidates: 0, emitted: 0, batches: 1, workersUsed: 0, peakPending: 0 }
	const first = diagnostics.sample(profile)!
	assert.equal(first.phase, 'between operations'); assert.equal(first.phases[4], 12); assert.equal(first.phases[5], 7)
	const second = diagnostics.sample(profile)!
	assert.equal(second.phases[4], 0); assert.equal(second.parentsPerSecond, 0)
	profile.phase = 'importing scratch'; profile.phaseActive = true; profile.phaseStarted = performance.now() - 100
	const importing = diagnostics.sample(profile)!
	assert.equal(importing.phase, 'importing scratch'); assert.ok(importing.phases[5] >= 100)
} finally {
	diagnostics.close()
	await new Promise<void>((resolve, reject) => db.close(error => error ? reject(error) : resolve()))
}

// Replay the supplied completion pattern. Small rate variation at an already
// large processed count must not turn a few-hour forecast into a multi-day one.
const points = [[0, 23.84], [62, 23.99], [126, 24.15], [187, 24.30], [248, 24.47], [312, 24.60], [374, 24.75]]
for (const limit of [1, 4]) {
	const model = new GenerationEstimator(5, 3, .2, limit)
	const forecasts: number[] = []
	for (const [seconds, percent] of points) {
		const progress = { depth: 4, processed: Math.round(percent * 1e6), total: 100e6, states: 1, overallDone: Math.round(percent * 1e6), overallTotal: 100e6 }
		model.update(progress, seconds * 1000)
		const remaining = model.remainingMs(progress)
		if (remaining !== undefined) forecasts.push(remaining)
	}
	assert.ok(forecasts.length >= 3)
	assert.ok(Math.max(...forecasts) / Math.min(...forecasts) < 1.5)
	assert.ok(forecasts.every(ms => ms > 6 * 3600000 && ms < 12 * 3600000))
}
// Even with extrapolation explicitly enabled, a long but narrow work span
// cannot justify a trend. Short restart windows must not amplify noise.
const ordinary = new GenerationEstimator(5, 3, .2, 1), extrapolated = new GenerationEstimator(5, 3, .2, 4)
let work = 1e9, time = 0
for (let i = 0; i < 30; i++) {
	const progress = { depth: 4, processed: work, total: 4e9, states: 1, overallDone: work, overallTotal: 4e9 }
	ordinary.update(progress, time); extrapolated.update(progress, time)
	assert.equal(extrapolated.remainingMs(progress), ordinary.remainingMs(progress))
	work += 100000; time += [60000, 62000, 59000, 64000, 61000][i % 5]
}

// A trend with sufficient history and work span still forecasts rising cost
// when the user explicitly enables extrapolation.
const supported = new GenerationEstimator(5, 3, .2, 4)
let processed = 1000, timestamp = 0, lastCost = 0
supported.update({ depth: 4, processed, total: 10000, states: 1 }, timestamp)
for (let i = 0; i < 20; i++) {
	lastCost = 10 + 2 * Math.log((processed + 50) / 1000)
	processed += 100; timestamp += lastCost * 100
	supported.update({ depth: 4, processed, total: 10000, states: 1 }, timestamp)
}
assert.ok(supported.remainingMs({ depth: 4, processed, total: 10000, states: 1, overallDone: processed, overallTotal: 10000 })! > (10000 - processed) * lastCost)

assert.equal(parseConfig({}).database.etaMaximumSlowdown, 1)
for (const database of [{ etaTrendMinimumSamples: 2 }, { etaTrendWindowSamples: 5, etaTrendMinimumSamples: 10 }, { etaTrendMinimumWorkGrowth: 0 }, { etaTrendMinimumWorkGrowth: -1 }]) assert.throws(() => parseConfig({ database }))
console.log('Interval writer overlap, committed throughput, separate import timing, idle phases and production ETA trace regressions passed')
