import type { SharedTable } from './shared-table.js'
import { TemplateLibrary, TemplateRule } from './templates.js'
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

type Job = { solver: 'local' | 'affine' | 'broad' | 'shuffle', restartOnImprovement: boolean, budgetMs: number, gates: Gate[], wires: number, stopSignal?: SharedArrayBuffer, onProgress?: (gates: number, activity?: WorkerActivity, snapshot?: Gate[]) => void, resolve: (gates: Gate[]) => void, reject: (error: Error) => void }
export class WorkerPool {
	private slots: { worker: Worker, job?: Job, retiring?: boolean }[] = []
	private queue: Job[] = []
	private failure?: Error
	private concurrency: number
	private shared = new TemplateLibrary(config.workers.sharedTemplateEntries, config.synthesis.maximumWires, config.synthesis.maximumWindowGates)
	constructor(private size: number, private workerUrl = new URL('./worker.js', import.meta.url), private sharedTables: SharedTable[] = [], private seed?: number, private maximumChecks = 0) {
		if (!Number.isSafeInteger(size) || size < 1) throw new Error('Invalid worker pool size')
		this.concurrency = size
	}
	setConcurrency(limit: number) {
		if (!Number.isSafeInteger(limit) || limit < 1 || limit > this.size) throw new Error('Invalid worker concurrency')
		this.concurrency = limit
		this.dispatch()
	}
	async trimIdle() {
		const retired: Worker[] = []
		for (let i = this.slots.length - 1; i >= 0 && this.slots.length > this.concurrency; i--) {
			const slot = this.slots[i]
			if (slot.job) continue
			slot.retiring = true; this.slots.splice(i, 1); retired.push(slot.worker)
		}
		await Promise.all(retired.map(worker => worker.terminate()))
	}
	run(gates: Gate[], wires: number, onProgress?: (gates: number, activity?: WorkerActivity, snapshot?: Gate[]) => void, stopSignal?: SharedArrayBuffer, budgetMs = config.workers.jobSeconds * 1000, restartOnImprovement = false, solver: 'local' | 'affine' | 'broad' | 'shuffle' = 'local'): Promise<Gate[]> {
		if (this.failure) return Promise.reject(this.failure)
		if (!Number.isFinite(budgetMs) || budgetMs <= 0) return Promise.reject(new Error('Invalid job budget'))
		return new Promise((resolve, reject) => {
			this.queue.push({ solver, restartOnImprovement, budgetMs, gates, wires, stopSignal, onProgress, resolve, reject })
			this.dispatch()
		})
	}
	private dispatch() {
		while (this.queue.length) {
			const next = this.queue[0]
			if (next.stopSignal && Atomics.load(new Int32Array(next.stopSignal), 0) !== 0) {
				this.queue.shift()!.resolve(next.gates)
				continue
			}
			if (this.slots.filter(slot => slot.job).length >= this.concurrency) return
			let slot = this.slots.find(slot => !slot.job)
			if (!slot) {
				if (this.slots.length >= this.size) return
				const worker = new Worker(this.workerUrl, { workerData: { solverConfig: config, sharedTables: this.sharedTables, solverSeed: this.seed === undefined ? undefined : this.seed + this.slots.length, maximumChecks: this.maximumChecks } })
				slot = { worker }
				const current = slot
				this.slots.push(current)
				worker.on('message', (message: { gates?: Gate[], error?: string, progress?: number, activity?: WorkerActivity, snapshot?: Gate[], sharedTemplates?: TemplateRule[] }) => {
					if (config.workers.shareTemplates && message.sharedTemplates?.length) {
						this.shared.importShared(message.sharedTemplates, config.workers.sharedTemplateBatch, true)
						const rules = this.shared.drainShared(config.workers.sharedTemplateBatch)
						if (rules.length) for (const peer of this.slots) if (peer !== current) peer.worker.postMessage({ sharedTemplates: rules })
					}
					const job = current.job
					const activity = message.activity ? { ...message.activity, workerId: current.worker.threadId } : undefined
					if (message.progress !== undefined) { job?.onProgress?.(message.progress, activity, message.snapshot); return }
					if (message.gates === undefined && message.error === undefined) return
					if (message.gates !== undefined && activity) job?.onProgress?.(message.gates.length, activity)
					current.job = undefined
					if (message.error) { this.fail(new Error(message.error)); job?.reject(this.failure!); return }
					job?.resolve(message.gates!)
					this.dispatch()
				})
				if (config.workers.shareTemplates) {
					const rules = this.shared.exportShared(config.workers.sharedTemplateEntries)
					for (let i = 0; i < rules.length; i += config.workers.sharedTemplateBatch) worker.postMessage({ sharedTemplates: rules.slice(i, i + config.workers.sharedTemplateBatch) })
				}
				worker.on('error', error => this.fail(error))
				worker.on('exit', code => {
					if (!this.failure && !current.retiring) this.fail(new Error(`Worker exited unexpectedly (${code})`))
				})
			}
			slot.job = this.queue.shift()!
			slot.worker.postMessage({ gates: slot.job.gates, wires: slot.job.wires, stopSignal: slot.job.stopSignal, budgetMs: slot.job.budgetMs, restartOnImprovement: slot.job.restartOnImprovement, solver: slot.job.solver })
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
