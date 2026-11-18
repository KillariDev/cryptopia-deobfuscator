import { parentPort, workerData } from 'node:worker_threads'
import { sweepFactored } from './sat-sweeping-core.js'

const { gates, maximumWires, maximumNodes, maximumEdges, budgetMs } = workerData
const deadline = performance.now() + budgetMs
try {
	const result = await sweepFactored(gates, { maximumWires, maximumNodes, maximumEdges, stopped: () => performance.now() >= deadline }, deadline)
	parentPort!.postMessage({ result })
} catch (error) { parentPort!.postMessage({ error: String(error) }) }
