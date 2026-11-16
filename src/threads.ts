import { config } from './config.js'
import { Worker } from 'worker_threads'
import { availableParallelism } from 'os'
import { Gate } from './types.js'
import { WorkerActivity } from './logging.js'

export function configuredWorkerCount() {
	const setting = process.env.OPTIMIZER_WORKERS
	const count = setting === undefined ? Math.min(config.workers.maximum, availableParallelism()) : Number(setting)
	if (!Number.isSafeInteger(count) || count < 1) throw new Error('OPTIMIZER_WORKERS must be a positive integer')
	return count
}

type Job = { gates: Gate[], wires: number, stopSignal?: SharedArrayBuffer, onProgress?: (gates: number, activity?: WorkerActivity, snapshot?: Gate[]) => void, resolve: (gates: Gate[]) => void, reject: (error: Error) => void }
export class WorkerPool {
	private slots: { worker: Worker, job?: Job }[] = []
	private queue: Job[] = []
	private failure?: Error
	constructor(private size: number, private workerUrl = new URL('./worker.js', import.meta.url)) {
		if (!Number.isSafeInteger(size) || size < 1) throw new Error('Invalid worker pool size')
	}
	run(gates: Gate[], wires: number, onProgress?: (gates: number, activity?: WorkerActivity, snapshot?: Gate[]) => void, stopSignal?: SharedArrayBuffer): Promise<Gate[]> {
		if (this.failure) return Promise.reject(this.failure)
		return new Promise((resolve, reject) => {
			this.queue.push({ gates, wires, stopSignal, onProgress, resolve, reject })
			this.dispatch()
		})
	}
	private dispatch() {
		while (this.queue.length) {
			let slot = this.slots.find(slot => !slot.job)
			if (!slot) {
				if (this.slots.length >= this.size) return
				const worker = new Worker(this.workerUrl, { workerData: { solverConfig: config } })
				slot = { worker }
				const current = slot
				this.slots.push(current)
				worker.on('message', (message: { gates?: Gate[], error?: string, progress?: number, activity?: WorkerActivity, snapshot?: Gate[] }) => {
					const job = current.job
					if (message.progress !== undefined) { job?.onProgress?.(message.progress, message.activity, message.snapshot); return }
					current.job = undefined
					if (message.error) { this.fail(new Error(message.error)); job?.reject(this.failure!); return }
					job?.resolve(message.gates!)
					this.dispatch()
				})
				worker.on('error', error => this.fail(error))
				worker.on('exit', code => {
					if (!this.failure) this.fail(new Error(`Worker exited unexpectedly (${code})`))
				})
			}
			slot.job = this.queue.shift()!
			slot.worker.postMessage({ gates: slot.job.gates, wires: slot.job.wires, stopSignal: slot.job.stopSignal })
		}
	}
	private fail(error: Error) {
		if (this.failure) return
		this.failure = error
		for (const slot of this.slots) { slot.job?.reject(error); slot.job = undefined }
		for (const job of this.queue.splice(0)) job.reject(error)
	}
	async close() {
		this.fail(new Error('Worker pool closed'))
		await Promise.all(this.slots.map(slot => slot.worker.terminate()))
	}
}
