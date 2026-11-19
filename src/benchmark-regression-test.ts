import assert from 'node:assert/strict'
import { fork } from 'node:child_process'
import { once } from 'node:events'
import { readFileSync } from 'node:fs'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, resolve } from 'node:path'
import { ablationVariants, benchmarkSettings, benchmarkOrder } from './benchmark-variants.js'
import { summarizeBenchmarks } from './benchmark-report.js'
import { readCaseManifest, caseSettings } from './benchmark-cases.js'
import { config, parseConfig } from './config.js'
import { initializeRainbowTables, openRainbowPortfolio } from './rainbow-portfolio.js'
import { loadSharedTables } from './shared-table.js'
import { functionKey } from './semantic.js'
import { massOptimizeStep } from './processing.js'
import { independentComponents } from './search.js'
import { LimitedMap } from './limitedMap.js'
import { Gate, CircuitData } from './types.js'

const configurationBefore = structuredClone(config)
const baseline = benchmarkSettings(config, 'reference')
const changes = (a: unknown, b: unknown, path = ''): string[] => {
	if (a && b && typeof a === 'object' && typeof b === 'object') return [...new Set([...Object.keys(a), ...Object.keys(b)])].flatMap(key => changes((a as Record<string, unknown>)[key], (b as Record<string, unknown>)[key], path ? `${path}.${key}` : key))
	return Object.is(a, b) ? [] : [path]
}
const expected = { 'shared-tables': 'database.sharedTables', components: 'search.independentComponents', 'stable-arms': 'search.stableSearchArms', decay: 'search.schedulerDecay', lru: 'cache.lookupPolicy' }
assert.deepEqual(ablationVariants.filter(name => name !== 'reference' && name !== 'tuned'), Object.keys(expected), 'new variants need a one-control regression test')
for (const [variant, key] of Object.entries(expected)) {
	assert.deepEqual(changes(baseline, benchmarkSettings(config, variant as typeof ablationVariants[number])), [key])
}
assert.deepEqual(config, configurationBefore, 'variant construction leaves production settings intact')
for (let repeat = 0; repeat < 4; repeat++) for (let workers = 0; workers < 3; workers++) assert.deepEqual(benchmarkOrder(ablationVariants, repeat, workers).slice().sort(), [...ablationVariants].sort())

const originalSettings = structuredClone(config)
assert.equal(benchmarkSettings(config, 'tuned-no-stable').search.stableSearchArms, false)
assert.equal(benchmarkSettings(config, 'tuned-conservative').search.independentComponents, false)
assert.deepEqual(config, originalSettings)
const result = (repeat: number, variant: string, rate: number) => ({ repeat, variant, workers: 1, gatesPerSecond: rate, removed: rate * 10, wallMs: 10000, peakRssBytes: 1048576 })
const summary = summarizeBenchmarks([result(0, 'reference', 10), result(1, 'reference', 100), result(2, 'reference', 0), result(0, 'lru', 20), result(1, 'lru', 50), result(2, 'lru', 5)])
assert.deepEqual(summary.find(item => item.variant === 'lru')!.pairedReferenceRatios, [2, 0.5])
assert.equal(summary.find(item => item.variant === 'lru')!.medianPairedReferenceRatio, 1.25)
assert.equal(summarizeBenchmarks([result(0, 'lru', 1)])[0].medianPairedReferenceRatio, null)

const path = resolve(config.benchmark.caseManifest), manifest = readCaseManifest(path)
const directory = await mkdtemp(resolve(tmpdir(), 'benchmark-regressions-'))
const saved = structuredClone(config)
try {
	const noRainbowSettings = resolve(directory, 'no-rainbow.json')
	await writeFile(noRainbowSettings, JSON.stringify({
		strategies: { rainbow: { enabled: false } },
		files: { databaseDirectory: resolve(directory, 'missing') },
		benchmark: { seconds: 0.1 },
	}))
	const trial = fork(new URL('./benchmark-trial.js', import.meta.url), [], {
		env: { ...process.env, OPTIMIZER_CONFIG: noRainbowSettings }, execArgv: [],
	})
	const exited = once(trial, 'exit'), reply = once(trial, 'message')
	const empty = { wire_count: 1, gate_count: 0, gates: [] }
	trial.send({ input: empty, original: empty, workers: 1, seed: 1 })
	const [message] = await reply
	assert.equal((message as { result?: { finalGates: number } }).result?.finalGates, 0)
	assert.deepEqual(await exited, [0, null])
	config.files.databaseDirectory = directory
	await initializeRainbowTables(manifest.tables)
	const available = caseSettings(manifest, false)
	available.database.tables = manifest.tables
	for (const variant of ablationVariants) {
		const settings = benchmarkSettings(available, variant)
		Object.assign(config, settings)
		const snapshots = await loadSharedTables(), tables = await openRainbowPortfolio(manifest.tables, snapshots)
		try {
			for (const item of manifest.cases) {
				const circuit = JSON.parse(readFileSync(resolve(dirname(path), item.input), 'utf8')) as CircuitData
				const gates = circuit.gates.map(([a, b, target, gate_i]) => ({ a, b, target, gate_i }))
				assert.equal(functionKey(gates, circuit.wire_count), item.expectedTruthKey)
				const components = config.search.independentComponents ? independentComponents(gates) : [gates]
				const results: Gate[][] = []
				for (const component of components) {
					let current = component
					const lookup = new LimitedMap<string, Gate[] | null>(1000, config.cache.lookupPolicy), processed = new LimitedMap<string, boolean>(1000)
					// Fixed work, not a timing assertion: each accepted pass must simplify.
					for (let pass = 0; pass <= component.length * 2; pass++) {
						let changed = false
						for (let size = 2; size <= Math.min(12, current.length); size++) {
							const next = await massOptimizeStep(tables, lookup, processed, current, size, false, false)
							if (next.changed) { current = next.gates; changed = true; break }
						}
						if (!changed) break
					}
					results.push(current)
				}
				const reduced = results.flat()
				assert.equal(functionKey(reduced, circuit.wire_count), item.expectedTruthKey, `${item.id}/${variant}: semantics`)
				assert.ok(reduced.length <= item.maximumDeterministicGates, `${item.id}/${variant}: deterministic reduction coverage regressed`)
			}
		} finally { await tables.close() }
	}
} finally { Object.assign(config, saved); await rm(directory, { recursive: true, force: true }) }
assert.throws(() => parseConfig({ benchmark: { mode: 'unknown' } }))
assert.throws(() => parseConfig({ benchmark: { variants: ['unknown'] } }))
assert.throws(() => parseConfig({ benchmark: { variants: ['reference', 'reference'] } }))
assert.throws(() => parseConfig({ benchmark: { decayFactor: 1.1 } }))
assert.throws(() => parseConfig({ benchmark: { caseOutputDirectory: '../input' } }))
console.log('One-feature variants, paired summaries and frozen benchmark-case regression checks passed')
