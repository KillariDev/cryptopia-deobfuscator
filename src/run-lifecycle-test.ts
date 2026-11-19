import assert from 'node:assert/strict'
import { spawn, spawnSync } from 'node:child_process'
import { once } from 'node:events'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as wait } from 'node:timers/promises'
import { fileURLToPath } from 'node:url'
import { optimizerExitMessage } from './exit-status.js'
import { withPuzzleLock } from './storage.js'

assert.match(optimizerExitMessage(3221226505), /0xC0000409.*\nWindows reported a native fail-fast crash/)
assert.equal(optimizerExitMessage(-1073740791), optimizerExitMessage(3221226505).replace('3221226505', '-1073740791'))
assert.match(optimizerExitMessage(0xC000012D), /insufficient memory or commit capacity/)
assert.equal(optimizerExitMessage(1), 'Optimizer process exited with code 1.')

const moduleUrl = new URL('./run-lifecycle.js', import.meta.url).href
const stalled = spawnSync(process.execPath, ['--input-type=module', '-e', `
import {RunLifecycle} from ${JSON.stringify(moduleUrl)};
const run=new RunLifecycle();run.setPhase('loading shared snapshots');
await run.run(()=>new Promise(()=>{}));
`], { encoding: 'utf8', timeout: 5000 })
assert.equal(stalled.status, 1)
assert.match(stalled.stderr, /stopped unexpectedly while loading shared snapshots/)
const complete = spawnSync(process.execPath, ['--input-type=module', '-e', `
import {RunLifecycle} from ${JSON.stringify(moduleUrl)};
await new RunLifecycle().run(async()=>{});
`], { encoding: 'utf8', timeout: 5000 })
assert.equal(complete.status, 0)
assert.equal(complete.stderr, '')
const failed = spawnSync(process.execPath, [fileURLToPath(new URL('./launch.js', import.meta.url)), '--invalid-option'], { encoding: 'utf8', timeout: 5000 })
assert.notEqual(failed.status, 0)
assert.match(failed.stderr, /Optimizer process exited with code/)

const emptyDirectory = await mkdtemp(join(tmpdir(), 'optimizer-empty-'))
try {
	const emptyInput = join(emptyDirectory, 'empty.json')
	const settings = join(emptyDirectory, 'settings.json')
	await writeFile(emptyInput, JSON.stringify({ wire_count: 1, gate_count: 0, gates: [] }))
	await writeFile(settings, JSON.stringify({ files: { databaseDirectory: join(emptyDirectory, 'missing') } }))
	const result = spawnSync(process.execPath, [fileURLToPath(new URL('./launch.js', import.meta.url)), emptyInput], {
		env: { ...process.env, OPTIMIZER_CONFIG: settings }, encoding: 'utf8', timeout: 5000,
	})
	assert.equal(result.status, 0, result.stderr)
	assert.match(result.stdout, /Optimization complete: no gates remain/)
	assert.doesNotMatch(result.stdout, /Initializing rainbow table/)
} finally {
	await rm(emptyDirectory, { recursive: true, force: true })
}

if (process.platform !== 'win32') {
	const directory = await mkdtemp(join(tmpdir(), 'optimizer-lifecycle-'))
	const puzzle = join(directory, 'puzzle')
	const settings = join(directory, 'settings.json')
	await writeFile(puzzle + '.json', JSON.stringify({ wire_count: 1, gate_count: 1, gates: [[0, 0, 0, 15]] }))
	await writeFile(settings, JSON.stringify({
		files: { dataDirectory: directory },
		workers: { maximum: 1 },
		strategies: { rainbow: { enabled: false } },
	}))
	const launch = fileURLToPath(new URL('./launch.js', import.meta.url))
	const env = { ...process.env, OPTIMIZER_CONFIG: settings, OPTIMIZER_WORKERS: '1' }
	const launcher = spawn(process.execPath, [launch, puzzle + '.json'], { env, detached: true })
	let output = ''
	launcher.stdout.on('data', chunk => { output += String(chunk) })
	launcher.stderr.on('data', chunk => { output += String(chunk) })
	const exited = once(launcher, 'exit')
	try {
		const deadline = performance.now() + 5000
		while (!output.includes('Starting optimizer') && launcher.exitCode === null && performance.now() < deadline) await wait(10)
		assert.match(output, /Starting optimizer/)
		const latest = await readFile(puzzle + '-latest.json', 'utf8')
		const competing = spawnSync(process.execPath, [launch, puzzle + '.json', '--startover'], { env, encoding: 'utf8', timeout: 5000 })
		assert.equal(competing.status, 1, competing.stderr)
		assert.match(competing.stderr, /An optimizer is already running/)
		assert.equal(await readFile(puzzle + '-latest.json', 'utf8'), latest)
		launcher.kill('SIGTERM')
		const timeout = new AbortController()
		try {
			assert.deepEqual(await Promise.race([exited, wait(5000, 'timeout', { signal: timeout.signal })]), [null, 'SIGTERM'])
		} finally {
			timeout.abort()
		}
		assert.equal(await withPuzzleLock(puzzle, async () => 'released'), 'released', 'launcher termination also stops its optimizer and releases the lock')
	} finally {
		if (launcher.pid) {
			try { process.kill(-launcher.pid, 'SIGKILL') }
			catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error }
		}
		await rm(directory, { recursive: true, force: true })
	}
}
console.log('Run lifecycle: unfinished startup is diagnosed, normal completion is quiet, and child failures report their exit code')
