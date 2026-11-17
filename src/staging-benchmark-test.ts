import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { spawn } from 'child_process'
import { fileURLToPath } from 'url'
import { config } from './config.js'
const directory = mkdtempSync(join(tmpdir(), 'staging-benchmark-test-'))
try {
	const settings = structuredClone(config)
	settings.files.dataDirectory = directory
	settings.database.generationSqlParameters = 1000
	const path = join(directory, 'settings.json')
	writeFileSync(path, JSON.stringify(settings))
	await new Promise<void>((resolve, reject) => {
		const child = spawn(process.execPath, [fileURLToPath(new URL('./staging-benchmark.js', import.meta.url)), '--smoke'], { env: { ...process.env, OPTIMIZER_CONFIG: path }, stdio: ['ignore', 'ignore', 'inherit'] })
		child.once('error', reject)
		child.once('exit', code => code === 0 ? resolve() : reject(new Error(`Staging benchmark smoke failed (${code})`)))
	})
	const report = JSON.parse(readFileSync(join(directory, 'staging-benchmark-smoke.json'), 'utf8'))
	assert.equal(report.results.length, 7)
	assert.equal(new Set(report.results.map((row: { resultDigest: string }) => row.resultDigest)).size, 1)
	const prepared = report.results.find((row: { variant: string }) => row.variant === 'prepared-large')
	assert.ok(prepared.parameters >= 5 && prepared.parameters <= 1000, 'selected settings reach the benchmark writer')
	assert.ok(prepared.statementStats.statementsPrepared > 0)
	assert.match(report.writerRuntimeSha256, /^[0-9a-f]{64}$/)
} finally { rmSync(directory, { recursive: true, force: true }) }
console.log('Seven-variant staging benchmark smoke and report equivalence checks passed')
