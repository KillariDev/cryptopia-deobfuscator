import { Worker } from 'worker_threads'
import { Gate } from './types.js'
import { ExpansionResult, ExpansionTask } from './generation-expansion.js'

type Job = { task: ExpansionTask, resolve: (result: ExpansionResult) => void, reject: (error: Error) => void }
/** The caller bounds queued CPU jobs, independently of staging database connections. */
export class GenerationPool {
	private slots: { worker: Worker, job?: Job }[] = []
	private queue: Job[] = []
	private failure?: Error
	private closing = false
	constructor(private size: number, private wires: number, private catalog: Gate[], private url = new URL('./generation-worker.js', import.meta.url)) {
		if (!Number.isSafeInteger(size) || size < 1) throw new Error('Invalid generation worker count')
	}
	get workerCount() { return this.slots.length }
	get activity() { return { running: this.slots.filter(slot => slot.job).length, queued: this.queue.length } }
	run(task: ExpansionTask): Promise<ExpansionResult> {
		if (this.failure || this.closing) return Promise.reject(this.failure ?? new Error('Generation pool closed'))
		return new Promise((resolve, reject) => { this.queue.push({ task, resolve, reject }); this.dispatch() })
	}
	private dispatch() {
		while (this.queue.length && !this.failure && !this.closing) {
			let slot = this.slots.find(slot => !slot.job)
			if (!slot) {
				if (this.slots.length >= this.size) return
				try {
					slot = { worker: new Worker(this.url, { workerData: { wires: this.wires, catalog: this.catalog } }) }
				} catch (error) { this.fail(error instanceof Error ? error : new Error(String(error))); return }
				this.slots.push(slot)
				const current = slot
				current.worker.on('message', ({ result, error }: { result?: ExpansionResult, error?: string }) => {
					if (!current.job) return
					if (error || !result) { this.fail(new Error(error ?? 'Invalid generation worker response')); return }
					const job = current.job; current.job = undefined
					job.resolve(result)
					this.dispatch()
				})
				current.worker.on('error', error => this.fail(error))
				current.worker.on('exit', code => { if (!this.closing) this.fail(new Error(`Generation worker exited unexpectedly (${code})`)) })
			}
			slot.job = this.queue.shift()!
			try { slot.worker.postMessage(slot.job.task, [slot.job.task.parents]) }
			catch (error) { this.fail(error instanceof Error ? error : new Error(String(error))); return }
		}
	}
	private fail(error: Error) {
		this.failure ??= error
		for (const slot of this.slots) { slot.job?.reject(this.failure); slot.job = undefined }
		for (const job of this.queue.splice(0)) job.reject(this.failure)
	}
	async close() {
		this.closing = true
		this.fail(new Error('Generation pool closed'))
		await Promise.allSettled(this.slots.map(slot => slot.worker.terminate()))
	}
}
