import { parentPort, workerData } from 'worker_threads'
import { ExpansionKernel, ExpansionTask } from './generation-expansion.js'

const kernel = new ExpansionKernel(workerData.wires, workerData.catalog)
parentPort!.on('message', (task: ExpansionTask) => {
	try {
		const result = kernel.expand(task)
		parentPort!.postMessage({ result }, [result.candidates])
	} catch (error) { parentPort!.postMessage({ error: String(error) }) }
})
