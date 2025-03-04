import { parentPort, workerData } from 'worker_threads'
import { CircuitData, Gate } from './types.js'
import { optimize } from './processing.js'
import { getRainbowTable } from './rainbowtable.js'
import { logTimed, readJsonFile } from './utils.js'


const getRainbowTableConfig = () => {
	const rng = Math.random() 
	if (rng > 0.5) return { wires: 6, gates: 3 }
	return { wires: 3, gates: 4 }
	//return { wires: 9, gates: 2 }
}

const task = async (filename: string) => {
	logTimed(`Worker Started ${ filename }`)
	const inputCircuit = readJsonFile(filename) as CircuitData
	const gates: Gate[] = inputCircuit.gates.map((x) => ({ a: x[0], b: x[1], target: x[2], gate_i: x[3] }))
	const rainbow = getRainbowTableConfig()
	const db = getRainbowTable(rainbow.wires, rainbow.gates)
	await optimize(db, gates, inputCircuit.wire_count, filename, true, rainbow.wires)
	logTimed(`Worker Finished ${ filename }`)
}

task(workerData).then(result => parentPort?.postMessage(result))