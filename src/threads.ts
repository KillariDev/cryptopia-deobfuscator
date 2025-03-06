import { Worker } from 'worker_threads'

export const runWorker = async (filename: string) => {
	return new Promise<void>((resolve, reject) => {
		const worker = new Worker('./dist/worker.js', { workerData: filename })
		worker.on('message', async () => {})

		worker.on('error', (t: any) => {
			console.log('worker error')
			console.log(t)
			reject(t)
		})

		worker.on('exit', (code) => {
			if (code !== 0) reject(new Error(`Worker stopped with exit code ${ code }`))
			resolve()
		})
	})
}
