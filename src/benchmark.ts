import { fork, execFileSync } from 'child_process'
import { createHash } from 'crypto'
import { readFileSync, writeFileSync, mkdirSync, mkdtempSync, rmSync } from 'fs'
import { dirname, join, resolve } from 'path'
import { tmpdir, availableParallelism } from 'os'
import { fileURLToPath } from 'url'
import { config, configPath, parseConfig } from './config.js'
import { benchmarkSettings, benchmarkOrder, ablationVariants, comparisonVariants, BenchmarkVariant } from './benchmark-variants.js'
import { summarizeBenchmarks, BenchmarkResult } from './benchmark-report.js'
import { CircuitData } from './types.js'

const readCircuit = (path: string): CircuitData => {
	const circuit = JSON.parse(readFileSync(path, 'utf8')) as CircuitData
	if (!Number.isSafeInteger(circuit.wire_count) || circuit.wire_count < 1 || circuit.wire_count > config.validation.maximumWires || !Array.isArray(circuit.gates) || circuit.gates.some(gate => !Array.isArray(gate) || gate.length !== 4 || gate.some((n, i) => !Number.isSafeInteger(n) || n < 0 || n >= (i === 3 ? 16 : circuit.wire_count)))) throw new Error(`Invalid circuit: ${path}`)
	return circuit
}
async function run() {
	const args = process.argv.slice(2), ablate = args[0] === '--ablate'
	if (ablate) args.shift()
	if (args.length < 1 || args.length > 2) throw new Error('Usage: npm run benchmark -- [--ablate] working.json [original.json]')
	const variants = config.benchmark.variants.length ? config.benchmark.variants as BenchmarkVariant[] : ablate || config.benchmark.mode === 'ablation' ? ablationVariants : comparisonVariants
	const inputPath = resolve(args[0]), originalPath = resolve(args[1] ?? args[0])
	const input = readCircuit(inputPath), original = readCircuit(originalPath)
	if (input.wire_count !== original.wire_count) throw new Error('Benchmark circuits must have the same wire count')
	const output = resolve(config.files.dataDirectory, config.benchmark.outputName)
	if ([inputPath, originalPath, configPath].includes(output)) throw new Error('Benchmark output would overwrite an input or settings file')
	const temporary = mkdtempSync(join(tmpdir(), 'solver-benchmark-'))
	const settingsFile = join(temporary, 'settings.json')
	const results: Record<string, unknown>[] = []
	let revision = 'unknown', workingTreeDirty: boolean | null = null
	try { revision = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(); workingTreeDirty = !!execFileSync('git', ['status', '--porcelain'], { encoding: 'utf8' }).trim() } catch {}
	const report = { schemaVersion: 2, mode: config.benchmark.variants.length ? 'custom' : variants === ablationVariants ? 'ablation' : 'comparison', variants, revision, workingTreeDirty, node: process.version, platform: process.platform, availableCpus: availableParallelism(), inputPath, originalPath, inputHash: createHash('sha256').update(JSON.stringify(input)).digest('hex'), originalHash: createHash('sha256').update(JSON.stringify(original)).digest('hex'), settings: config, results }
	mkdirSync(dirname(output), { recursive: true })
	try {
		for (let repeat = 0; repeat < config.benchmark.repeats; repeat++) for (const [workerIndex, workers] of config.benchmark.workerCounts.entries()) {
			for (const variant of benchmarkOrder(variants, repeat, workerIndex)) {
				const settings = benchmarkSettings(config, variant)
				writeFileSync(settingsFile, JSON.stringify(parseConfig(settings)))
				const result = await new Promise<Record<string, unknown>>((resolveTrial, reject) => {
					const child = fork(fileURLToPath(new URL('./benchmark-trial.js', import.meta.url)), [], { env: { ...process.env, OPTIMIZER_CONFIG: settingsFile }, execArgv: [`--max-old-space-size=${config.runtime.heapMegabytes}`], stdio: ['ignore', 'pipe', 'pipe', 'ipc'] })
					let result: Record<string, unknown> | undefined, error = ''
					child.stderr!.on('data', chunk => { error = (error + String(chunk)).slice(-8192) })
					child.stdout!.on('data', () => {})
					const watchdog = setTimeout(() => { child.kill(); reject(new Error('Benchmark trial exceeded its budget plus allowed overrun')) }, (config.benchmark.seconds + config.benchmark.maximumOverrunSeconds) * 1000)
					child.once('error', failure => { clearTimeout(watchdog); reject(failure) })
					child.on('message', (message: { result?: Record<string, unknown>, error?: string }) => { if (message.result) result = message.result; if (message.error) error = message.error })
					child.once('exit', code => { clearTimeout(watchdog); if (code === 0 && result) resolveTrial(result); else reject(new Error(error || `Benchmark trial exited (${code})`)) })
					child.send({ input, original, workers, seed: config.benchmark.seed + repeat })
				})
				results.push({ repeat, variant, ...result, controls: { adaptiveConcurrency: settings.workers.adaptiveConcurrency, sharedTables: settings.database.sharedTables, independentComponents: settings.search.independentComponents, stableSearchArms: settings.search.stableSearchArms, schedulerDecay: settings.search.schedulerDecay, lookupPolicy: settings.cache.lookupPolicy } })
				writeFileSync(output, JSON.stringify({ ...report, summary: summarizeBenchmarks(results as unknown as BenchmarkResult[]) }, null, 2) + '\n')
				console.log(`Completed ${variant} benchmark, ${workers} workers, repetition ${repeat + 1}`)
			}
		}
		console.log(`Benchmark report: ${output}`)
	} finally { rmSync(temporary, { recursive: true, force: true }) }
}
run().catch(error => { console.error(String(error)); process.exitCode = 1 })
