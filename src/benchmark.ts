import { fork, execFileSync } from 'child_process'
import { createHash } from 'crypto'
import { readFileSync, writeFileSync, mkdirSync, mkdtempSync, rmSync } from 'fs'
import { dirname, join, resolve } from 'path'
import { tmpdir, availableParallelism } from 'os'
import { fileURLToPath } from 'url'
import { config, configPath, parseConfig } from './config.js'
import { CircuitData } from './types.js'

const readCircuit = (path: string): CircuitData => {
	const circuit = JSON.parse(readFileSync(path, 'utf8')) as CircuitData
	if (!Number.isSafeInteger(circuit.wire_count) || circuit.wire_count < 1 || circuit.wire_count > config.validation.maximumWires || !Array.isArray(circuit.gates) || circuit.gates.some(gate => !Array.isArray(gate) || gate.length !== 4 || gate.some((n, i) => !Number.isSafeInteger(n) || n < 0 || n >= (i === 3 ? 16 : circuit.wire_count)))) throw new Error(`Invalid circuit: ${path}`)
	return circuit
}
async function run() {
	if (process.argv.length < 3 || process.argv.length > 4) throw new Error('Usage: npm run benchmark -- working.json [original.json]')
	const inputPath = resolve(process.argv[2]), originalPath = resolve(process.argv[3] ?? process.argv[2])
	const input = readCircuit(inputPath), original = readCircuit(originalPath)
	if (input.wire_count !== original.wire_count) throw new Error('Benchmark circuits must have the same wire count')
	const output = resolve(config.files.dataDirectory, config.benchmark.outputName)
	if ([inputPath, originalPath, configPath].includes(output)) throw new Error('Benchmark output would overwrite an input or settings file')
	const temporary = mkdtempSync(join(tmpdir(), 'solver-benchmark-'))
	const settingsFile = join(temporary, 'settings.json')
	const results: Record<string, unknown>[] = []
	let revision = 'unknown'
	try { revision = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim() } catch {}
	const report = { revision, node: process.version, platform: process.platform, availableCpus: availableParallelism(), inputPath, originalPath, inputHash: createHash('sha256').update(JSON.stringify(input)).digest('hex'), originalHash: createHash('sha256').update(JSON.stringify(original)).digest('hex'), settings: config, results }
	mkdirSync(dirname(output), { recursive: true })
	try {
		for (let repeat = 0; repeat < config.benchmark.repeats; repeat++) for (const workers of config.benchmark.workerCounts) {
			// Alternate order across repetitions to reduce systematic warm-cache bias.
			for (const variant of repeat % 2 ? ['tuned', 'reference'] : ['reference', 'tuned']) {
				const settings = structuredClone(config)
				settings.workers.adaptiveConcurrency = false // Fixed counts are the experimental variable.
				if (variant === 'reference') {
					settings.database.sharedTables = false; settings.search.independentComponents = false
					settings.search.stableSearchArms = false; settings.search.schedulerDecay = 1; settings.cache.lookupPolicy = 'fifo'
				}
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
				writeFileSync(output, JSON.stringify(report, null, 2) + '\n')
				console.log(`Completed ${variant} benchmark, ${workers} workers, repetition ${repeat + 1}`)
			}
		}
		console.log(`Benchmark report: ${output}`)
	} finally { rmSync(temporary, { recursive: true, force: true }) }
}
run().catch(error => { console.error(String(error)); process.exitCode = 1 })
