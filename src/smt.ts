import { Worker } from 'node:worker_threads'
import { Gate } from './types.js'

// Terminating the owning isolate releases WASM memory deterministically. Killing
// Z3's helper threads alone leaves repeated instances waiting for GC.
export function synthesizeSMT(original: Gate[], wires: number, maxGates: number, timeoutMs: number): Promise<Gate[] | undefined> {
	return new Promise((resolve, reject) => {
		const worker = new Worker(new URL('./smt-worker.js', import.meta.url), { workerData: { original, wires, maxGates, timeoutMs } })
		let settled = false
		const finish = (result?: Gate[], error?: Error) => {
			if (settled) return
			settled = true
			void worker.terminate().then(() => {
				if (error) reject(error)
				else resolve(result)
			}, reject)
		}
		worker.once('message', (message: { result?: Gate[], error?: string }) => finish(message.result, message.error === undefined ? undefined : new Error(message.error)))
		worker.once('error', error => finish(undefined, error))
		worker.once('exit', code => {
			if (!settled) finish(undefined, new Error(`SMT worker exited without a result (${code})`))
		})
	})
}
