import assert from 'node:assert/strict'
import { Worker } from 'node:worker_threads'
import { synthesizeSMT } from './smt.js'
import { reportSmtDiagnostic } from './smt-solver.js'

const diagnostics: string[] = [], originalError = console.error
try {
	console.error = message => diagnostics.push(String(message))
	reportSmtDiagnostic('received "cleanupThread" command from terminated worker: 4')
	reportSmtDiagnostic('received "cleanupThread" command from terminated worker: 1')
	reportSmtDiagnostic('received "abort" command from terminated worker: 4')
	reportSmtDiagnostic('Z3 failed to initialize')
	assert.deepEqual(diagnostics, ['received "abort" command from terminated worker: 4', 'Z3 failed to initialize'])
} finally { console.error = originalError }

// Repeated attempts must return a valid simplification and leave no live Z3
// helper threads. Exercise both the main isolate and the optimizer's nesting.
const original = [{ a: 0, b: 0, target: 0, gate_i: 0 }]
for (let i = 0; i < 12; i++) assert.deepEqual(await synthesizeSMT(original, 1, 0, 1000), [])
const worker = new Worker(new URL('data:text/javascript,' + encodeURIComponent(`
import { parentPort } from 'node:worker_threads';
import { synthesizeSMT } from ${JSON.stringify(new URL('./smt.js', import.meta.url).href)};
for (let i = 0; i < 3; i++) {
 const result = await synthesizeSMT(${JSON.stringify(original)}, 1, 0, 1000);
 if (JSON.stringify(result) !== '[]') throw new Error('Invalid simplification');
}
parentPort.postMessage('done');
`)))
await new Promise<void>((resolve, reject) => {
	worker.once('error', reject)
	worker.once('exit', code => code === 0 ? resolve() : reject(new Error(`Worker exited (${code})`)))
})
console.log('SMT repeated allocation and nested worker checks passed')
