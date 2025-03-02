import * as fs from 'fs'
import { createDependencyGraph, getDependencyGraphAsStringWithGates } from './lineswapper.js'
import { gatesToText, logTimed, readJsonFile } from './utils.js'
import { CircuitData, Gate } from './types.js'
import { createRainbowTable } from './rainbowtable.js'
import { join, parse } from 'path'
import { drawDependencyGraph } from './drawGraph.js'
import { splitTaskAndRun } from './processing.js'

const run = async (pathToFileWithoutExt: string) => {
	logTimed(`Started to run job ${ pathToFileWithoutExt }`)
	const RAINBOW_TABLE_WIRES = 6
	const RAINBOW_TABLE_GATES = 3
	const db = await createRainbowTable(RAINBOW_TABLE_WIRES, RAINBOW_TABLE_GATES)
	const inputCircuit = readJsonFile(`${ pathToFileWithoutExt }.json`) as CircuitData
	logTimed('wire_count', inputCircuit.wire_count)
	logTimed('gate_count', inputCircuit.gates.length)
	const gates: Gate[] = inputCircuit.gates.map((x) => ({ a: x[0], b: x[1], target: x[2], gate_i: x[3] }))
	fs.writeFileSync(`${ pathToFileWithoutExt }.commands.json`, gatesToText(gates))
	const gatesToGraph = 3000
	if (gates.length < 3000) {
		drawDependencyGraph(gates.slice(0, gatesToGraph), `${ pathToFileWithoutExt }.dependency-graph.SLICE.png`, 32000, 4000)
		const dependencies = createDependencyGraph(gates.slice(0, gatesToGraph))
		fs.writeFileSync(`${ pathToFileWithoutExt }.dependency.SLICE.json`, getDependencyGraphAsStringWithGates(dependencies, gates), 'utf8')
	}
	try {
		//await optimize(db, gates, inputCircuit.wire_count, pathToFileWithoutExt)
		await splitTaskAndRun(pathToFileWithoutExt)
	} catch(e: unknown) {
		console.error(e)
	}
}

if (process.argv.length !== 3) throw new Error('filename missing')
const { dir, name } = parse(process.argv[2])
const filePath = join(dir, name)
run(filePath)
