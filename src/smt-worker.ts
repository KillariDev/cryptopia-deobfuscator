import { parentPort, workerData } from 'node:worker_threads'
import { synthesizeSMT } from './smt-solver.js'

const { original, wires, maxGates, timeoutMs } = workerData
try {
	const result = await synthesizeSMT(original, wires, maxGates, timeoutMs)
	parentPort!.postMessage({ result })
} catch (error) {
	parentPort!.postMessage({ error: String(error) })
}
