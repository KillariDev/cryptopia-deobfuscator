import { Worker } from 'node:worker_threads'
import { Gate } from './types.js'

/** Disposable isolate: cancellation releases both WASM memory and helper threads. */
export function runSolverWorker(url: URL, data: object, budgetMs: number, shouldStop: () => boolean): Promise<Gate[] | undefined> {
	if (shouldStop() || budgetMs <= 0) return Promise.resolve(undefined)
	return new Promise((resolve, reject) => {
		const worker = new Worker(url, { workerData: data })
		let settled = false
		let deadline: ReturnType<typeof setTimeout> | undefined, stop: ReturnType<typeof setInterval> | undefined
		const finish = (result?: Gate[], error?: Error) => {
			if (settled) return
			settled = true; clearTimeout(deadline); clearInterval(stop)
			void worker.terminate().then(() => error ? reject(error) : resolve(result), reject)
		}
		deadline = setTimeout(() => finish(), budgetMs)
		stop = setInterval(() => { if (shouldStop()) finish() }, 10)
		worker.once('message', (message: { result?: Gate[], error?: string }) => finish(message.result, message.error === undefined ? undefined : new Error(message.error)))
		worker.once('error', error => finish(undefined, error))
		worker.once('exit', code => { if (!settled) finish(undefined, new Error(`Solver worker exited without a result (${code})`)) })
	})
}
