import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { spawn } from 'child_process'
import { fileURLToPath } from 'url'
import { config } from './config.js'
const directory = mkdtempSync(join(tmpdir(), 'generation-benchmark-test-'))
try {
	const settings = structuredClone(config)
	settings.files.dataDirectory = directory
	settings.database.generationMinimumWork = 1
	settings.benchmark.generationFinalComparison = false
	settings.benchmark.generationWriterComparison = false
	settings.benchmark.generationStagingComparison = false
	settings.benchmark.generationPrefetchComparison = true
	const settingsFile = join(directory, 'settings.json')
	writeFileSync(settingsFile, JSON.stringify(settings))
	await new Promise<void>((resolve, reject) => {
		const child = spawn(process.execPath, [fileURLToPath(new URL('./generation-benchmark.js', import.meta.url)), '--smoke'], { env: { ...process.env, OPTIMIZER_CONFIG: settingsFile }, stdio: ['ignore', 'ignore', 'inherit'] })
		child.once('error', reject)
		child.once('exit', code => code === 0 ? resolve() : reject(new Error(`Generation benchmark smoke failed (${code})`)))
	})
	const report = JSON.parse(readFileSync(join(directory, 'generation-benchmark-smoke.json'), 'utf8'))
	assert.equal(report.results.length, 12)
	for (const result of report.results) {
		assert.equal(result.settings.database.generationPrefetch, result.variant !== 'serial')
		assert.equal(result.settings.logging.generationDiagnostics, result.variant === 'prefetch-diagnostics')
		assert.equal(result.validation, 'all-replacements-exhaustive')
		assert.ok(result.rows > 0 && result.generationMs > 0 && result.finalFileBytes > 0)
		assert.equal(result.settings.database.generationMinimumWork, 1, 'benchmark workers honor the selected JSON settings')
	}
	settings.benchmark.generationWriterComparison = true
	settings.benchmark.generationPrefetchComparison = false
	writeFileSync(settingsFile, JSON.stringify(settings))
	await new Promise<void>((resolve, reject) => {
		const child = spawn(process.execPath, [fileURLToPath(new URL('./generation-benchmark.js', import.meta.url)), '--smoke'], { env: { ...process.env, OPTIMIZER_CONFIG: settingsFile }, stdio: ['ignore', 'ignore', 'inherit'] })
		child.once('error', reject)
		child.once('exit', code => code === 0 ? resolve() : reject(new Error(`Writer comparison smoke failed (${code})`)))
	})
	const writers = JSON.parse(readFileSync(join(directory, 'generation-benchmark-smoke.json'), 'utf8'))
	assert.equal(writers.results.length, 24)
	for (const result of writers.results) {
		assert.equal(result.settings.database.generationCompactBindings, result.variant !== 'baseline')
		assert.equal(result.settings.database.generationStagingWriters, result.variant === 'writers-2' ? 2 : result.variant === 'writers-4' ? 4 : 1)
		assert.equal(result.validation, 'all-replacements-exhaustive')
		assert.ok(result.cpuMs > 0 && result.peakDatabaseBytes >= result.finalFileBytes)
	}

	settings.benchmark.generationWriterComparison = false
	settings.benchmark.generationFinalComparison = true
	writeFileSync(settingsFile, JSON.stringify(settings))
	await new Promise<void>((resolve, reject) => {
		const child = spawn(process.execPath, [fileURLToPath(new URL('./generation-benchmark.js', import.meta.url)), '--smoke'], { env: { ...process.env, OPTIMIZER_CONFIG: settingsFile }, stdio: ['ignore', 'ignore', 'inherit'] })
		child.once('error', reject)
		child.once('exit', code => code === 0 ? resolve() : reject(new Error(`Final lookup comparison failed (${code})`)))
	})
	const final = JSON.parse(readFileSync(join(directory, 'generation-benchmark-smoke.json'), 'utf8'))
	assert.equal(final.results.length, 8)
	for (const result of final.results) {
		assert.equal(result.settings.database.generationCountFinalInserts, result.variant === 'count-inserts')
		assert.ok(result.operations.some((row: { name: string }) => row.name === (result.variant === 'count-inserts' ? 'arm final counter' : 'final membership/count')))
	}

} finally { rmSync(directory, { recursive: true, force: true }) }
console.log('Fresh-process generation benchmark smoke checks passed')
