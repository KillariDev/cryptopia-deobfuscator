import { parentPort, workerData } from 'worker_threads'
import { CircuitData, Gate } from './types.js'
import { optimize, RAINBOW_TABLE_GATES, RAINBOW_TABLE_WIRES } from './processing.js'
import { getRainbowTable } from './rainbowtable.js'
import { logTimed, readJsonFile } from './utils.js'

const task = async (filename: string) => {
	logTimed(`Worker Started ${ filename }`)
	const inputCircuit = readJsonFile(filename) as CircuitData
	const gates: Gate[] = inputCircuit.gates.map((x) => ({ a: x[0], b: x[1], target: x[2], gate_i: x[3] }))
	const db = getRainbowTable(RAINBOW_TABLE_WIRES, RAINBOW_TABLE_GATES)
	await optimize(db, gates, inputCircuit.wire_count, filename, true)
	logTimed(`Worker Finished ${ filename }`)
}

task(workerData).then(result => parentPort?.postMessage(result))