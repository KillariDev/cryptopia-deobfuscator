import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { optimizerExitMessage } from './exit-status.js'

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
console.log('Run lifecycle: unfinished startup is diagnosed, normal completion is quiet, and child failures report their exit code')
