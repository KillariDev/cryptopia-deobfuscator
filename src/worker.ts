import { parentPort, workerData } from 'worker_threads'
import { CircuitData, Gate } from './types.js'
import { optimize } from './processing.js'
import { getRainbowTable, RAINBOW_TABLE_GATES, RAINBOW_TABLE_WIRES } from './rainbowtable.js'
import { logTimed, readJsonFile } from './utils.js'

const task = async (filename: string) => {
	logTimed(`Worker Started ${ filename }`)
	const inputCircuit = readJsonFile(filename) as CircuitData
	const gates: Gate[] = inputCircuit.gates.map((x) => ({ a: x[0], b: x[1], target: x[2], gate_i: x[3] }))
	const db = getRainbowTable(RAINBOW_TABLE_WIRES, RAINBOW_TABLE_GATES)
	await optimize(db, gates, inputCircuit.wire_count, filename, true, RAINBOW_TABLE_WIRES)
	logTimed(`Worker Finished ${ filename }`)
	return new Promise<void>((resolve, _reject) => {
		db.close((err) => {
			parentPort?.postMessage('finished working')
			resolve()
		})
	})
}

task(workerData)
