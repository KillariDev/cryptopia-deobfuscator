import { Worker } from 'worker_threads'
import path from 'path'

export const runWorker = async (filename: string) => {
	return new Promise<void>((resolve, reject) => {
		const worker = new Worker('./dist/worker.js', { workerData: filename })
		worker.on('message', (msg) => {
			worker.terminate()
			resolve()
		})
		worker.on('error', reject)
		worker.on('exit', (code) => {
			if (code !== 0) reject(new Error(`Worker stopped with exit code ${ code }`))
		})
	})
}