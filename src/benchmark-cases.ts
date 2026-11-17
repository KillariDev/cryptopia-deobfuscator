import { readFileSync, writeFileSync, mkdirSync, mkdtempSync, rmSync } from 'fs'
import { resolve, dirname, join } from 'path'
import { tmpdir } from 'os'
import { spawn } from 'child_process'
import { fileURLToPath } from 'url'
import { config, parseConfig, SolverConfig } from './config.js'
import { ablationVariants } from './benchmark-variants.js'
import { initializeRainbowTables } from './rainbow-portfolio.js'
import { functionKey } from './semantic.js'
import { CircuitData } from './types.js'

export type BenchmarkCase = { id: string, input: string, description: string, expectedTruthKey: string, maximumDeterministicGates: number }
export type CaseManifest = { version: number, tables: SolverConfig['database']['tables'], settings: Record<string, Record<string, unknown>>, cases: BenchmarkCase[] }

export function readCaseManifest(path: string): CaseManifest {
	const manifest = JSON.parse(readFileSync(path, 'utf8')) as CaseManifest
	if (manifest.version !== 1 || !Array.isArray(manifest.cases) || !manifest.cases.length || new Set(manifest.cases.map(item => item.id)).size !== manifest.cases.length || manifest.cases.some(item => typeof item.id !== 'string' || !/^[a-z0-9-]+$/.test(item.id) || typeof item.input !== 'string' || !/^[0-9a-f]+$/.test(item.expectedTruthKey) || !Number.isSafeInteger(item.maximumDeterministicGates) || item.maximumDeterministicGates < 0)) throw new Error('Invalid benchmark case manifest')
	return manifest
}

export function caseSettings(manifest: CaseManifest, smoke: boolean): SolverConfig {
	const settings = structuredClone(config)
	for (const [section, values] of Object.entries(manifest.settings ?? {})) {
		if (!Object.prototype.hasOwnProperty.call(settings, section) || !values || typeof values !== 'object' || Array.isArray(values)) throw new Error('Invalid benchmark case settings')
		const target = settings[section as keyof SolverConfig] as Record<string, unknown>
		for (const [key, value] of Object.entries(values)) {
			if (!Object.prototype.hasOwnProperty.call(target, key)) throw new Error(`Unknown benchmark case setting: ${section}.${key}`)
			target[key] = value
		}
	}
	settings.database.tables = manifest.tables
	settings.benchmark.mode = 'ablation'; settings.benchmark.variants = []
	if (smoke) { settings.benchmark.seconds = 0.2; settings.benchmark.repeats = 1; settings.benchmark.workerCounts = [1]; settings.benchmark.maximumChecks = 32 }
	return parseConfig(settings)
}

async function run() {
	if (process.argv.slice(2).some(arg => arg !== '--smoke')) throw new Error('Usage: npm run benchmark:cases -- [--smoke]')
	const smoke = process.argv.includes('--smoke'), manifestPath = resolve(config.benchmark.caseManifest)
	const manifest = readCaseManifest(manifestPath), settings = caseSettings(manifest, smoke)
	const output = resolve(config.files.dataDirectory, config.benchmark.caseOutputDirectory)
	mkdirSync(output, { recursive: true })
	settings.files.databaseDirectory = join(output, 'tables-v2')
	settings.files.dataDirectory = output
	mkdirSync(settings.files.databaseDirectory, { recursive: true })
	// This explicit suite owns only its small fixture-table portfolio.
	const oldDatabase = config.files.databaseDirectory
	try { config.files.databaseDirectory = settings.files.databaseDirectory; await initializeRainbowTables(settings.database.tables) }
	finally { config.files.databaseDirectory = oldDatabase }
	const temporary = mkdtempSync(join(tmpdir(), 'benchmark-cases-'))
	const reports: { id: string, path: string, summary: unknown }[] = []
	try {
		for (const item of manifest.cases) {
			settings.benchmark.outputName = `${item.id}.json`
			const settingsFile = join(temporary, 'settings.json')
			writeFileSync(settingsFile, JSON.stringify(settings))
			const path = resolve(dirname(manifestPath), item.input)
			const circuit = JSON.parse(readFileSync(path, 'utf8')) as CircuitData
			if (!Number.isInteger(circuit.wire_count) || circuit.wire_count < 1 || circuit.wire_count > 8 || functionKey(circuit.gates.map(([a, b, target, gate_i]) => ({ a, b, target, gate_i })), circuit.wire_count) !== item.expectedTruthKey) throw new Error(`Benchmark fixture ${item.id} differs from its frozen truth table`)
			await new Promise<void>((resolveCase, reject) => {
				const child = spawn(process.execPath, [fileURLToPath(new URL('./benchmark.js', import.meta.url)), '--ablate', path], { stdio: 'inherit', env: { ...process.env, OPTIMIZER_CONFIG: settingsFile } })
				child.once('error', reject)
				child.once('exit', code => code === 0 ? resolveCase() : reject(new Error(`Benchmark case ${item.id} failed (${code})`)))
			})
			const reportPath = join(output, settings.benchmark.outputName), report = JSON.parse(readFileSync(reportPath, 'utf8'))
			const expectedTrials = settings.benchmark.repeats * settings.benchmark.workerCounts.length * ablationVariants.length
			if (report.results.length !== expectedTrials || report.results.some((row: { validation: string, finalGates: number, initialGates: number }) => row.validation !== 'exhaustive' || row.finalGates > row.initialGates)) throw new Error(`Benchmark case ${item.id} failed validation`)
			reports.push({ id: item.id, path: reportPath, summary: report.summary })
			writeFileSync(join(output, 'suite.json'), JSON.stringify({ smoke, manifestPath, reports }, null, 2) + '\n')
		}
	} finally { rmSync(temporary, { recursive: true, force: true }) }
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) run().catch(error => { console.error(String(error)); process.exitCode = 1 })
