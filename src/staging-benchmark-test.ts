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
	for (const script of ['staging-benchmark', 'merge-benchmark', 'final-lookup-benchmark']) await new Promise<void>((resolve, reject) => {
		const child = spawn(process.execPath, [fileURLToPath(new URL(`./${script}.js`, import.meta.url)), '--smoke'], { env: { ...process.env, OPTIMIZER_CONFIG: path }, stdio: ['ignore', 'ignore', 'inherit'] })
		child.once('error', reject)
		child.once('exit', code => code === 0 ? resolve() : reject(new Error(`Staging benchmark smoke failed (${code})`)))
	})
	const report = JSON.parse(readFileSync(join(directory, 'staging-benchmark-smoke.json'), 'utf8'))
	assert.equal(report.results.length, 11)
	assert.equal(new Set(report.results.map((row: { resultDigest: string }) => row.resultDigest)).size, 1)
	const prepared = report.results.find((row: { variant: string }) => row.variant === 'prepared-large')
	assert.ok(prepared.parameters >= 5 && prepared.parameters <= 1000, 'selected settings reach the benchmark writer')
	assert.ok(prepared.statementStats.statementsPrepared > 0)
	assert.match(report.writerRuntimeSha256, /^[0-9a-f]{64}$/)
	const merges = JSON.parse(readFileSync(join(directory, 'merge-benchmark-smoke.json'), 'utf8'))
	assert.equal(merges.results.length, 2)
	assert.equal(new Set(merges.results.map((row: { digest: string }) => row.digest)).size, 1)
	const final = JSON.parse(readFileSync(join(directory, 'final-lookup-benchmark-smoke.json'), 'utf8'))
	assert.equal(final.results.length, 24)
	assert.match(final.runtimeSha256, /^[0-9a-f]{64}$/)
	for (const row of final.results) {
		const opposite = final.results.find((other: typeof row) => other.population === row.population && other.knownFraction === row.knownFraction && other.mode === row.mode && other.repeat === row.repeat && other.variant !== row.variant)
		assert.equal(row.digest, opposite.digest)
	}
} finally { rmSync(directory, { recursive: true, force: true }) }
console.log('Eleven-variant staging benchmark smoke and report equivalence checks passed')
