import { parentPort, workerData } from 'worker_threads'
import { CircuitData, Gate } from './types.js'
import { optimize } from './processing.js'
import { getRainbowTable } from './rainbowtable.js'
import { logTimed, readJsonFile } from './utils.js'


const task = async (filename: string) => {
	logTimed(`Worker Started ${ filename }`)
	const inputCircuit = readJsonFile(filename) as CircuitData
	const gates: Gate[] = inputCircuit.gates.map((x) => ({ a: x[0], b: x[1], target: x[2], gate_i: x[3] }))
	const rainbow = Math.random() < 0.5 ? { wires: 6, gates: 3 } : { wires: 3, gates: 4 }
	const db = getRainbowTable(rainbow.wires, rainbow.gates)
	await optimize(db, gates, inputCircuit.wire_count, filename, true, rainbow.wires)
	logTimed(`Worker Finished ${ filename }`)
}

task(workerData).then(result => parentPort?.postMessage(result))