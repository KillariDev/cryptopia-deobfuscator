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
	settings.benchmark.generationStagingComparison = true
	const settingsFile = join(directory, 'settings.json')
	writeFileSync(settingsFile, JSON.stringify(settings))
	await new Promise<void>((resolve, reject) => {
		const child = spawn(process.execPath, [fileURLToPath(new URL('./generation-benchmark.js', import.meta.url)), '--smoke'], { env: { ...process.env, OPTIMIZER_CONFIG: settingsFile }, stdio: ['ignore', 'ignore', 'inherit'] })
		child.once('error', reject)
		child.once('exit', code => code === 0 ? resolve() : reject(new Error(`Generation benchmark smoke failed (${code})`)))
	})
	const report = JSON.parse(readFileSync(join(directory, 'generation-benchmark-smoke.json'), 'utf8'))
	assert.equal(report.results.length, 8)
	for (const result of report.results) {
		assert.equal(result.settings.database.generationAppendStaging, result.variant === 'append')
		assert.equal(result.validation, 'all-replacements-exhaustive')
		assert.ok(result.rows > 0 && result.generationMs > 0 && result.finalFileBytes > 0)
		assert.equal(result.settings.database.generationMinimumWork, 1, 'benchmark workers honor the selected JSON settings')
	}
} finally { rmSync(directory, { recursive: true, force: true }) }
console.log('Fresh-process generation benchmark smoke checks passed')
