import * as fs from 'fs'
import sqlite3 from 'sqlite3'
import { createDependencyGraph, findSwappableLines, getDependencyGraphAsString, getDependencyGraphAsStringWithGates, shuffleLinesWithinGroups } from './lineswapper.js'
import { areBooleanArraysEqual, calculateAllOutputsArray, convertToOriginal, evalCircuit, findConvexSubsets, gatesToText, gateToText, generateCombinations, generateNRandomBooleanArray, getRandomNumberInRange, getVars, hashGates, ioHash, mapCircuit, mapVariablesToIndexes, readJsonFile, replace, reverseMapCircuit, simplifyGate, verifyCircuit } from './utils.js'
import { CircuitData, DependencyNode, Gate } from './types.js'
import { createRainbowTable, getReplacerById } from './rainbowtable.js'
import { LimitedMap } from './limitedMap.js'
import { findCriticalPath } from './cycles.js'
import { join, parse } from 'path'
import { drawDependencyGraph } from './drawGraph.js'

const removeVariable = (gates: Gate[], variable: number) => {
	return gates.filter((x) => x.target !== variable && !(x.a === x.b && x.a === variable)).map((gate) => {
		if (gate.a === variable) return simplifyGate({ ...gate, a: gate.b })
		if (gate.b === variable) return simplifyGate({ ...gate, b: gate.a })
		return gate
	})
}

const randomInputs = generateNRandomBooleanArray(102, 64)
const findProbabilisticUselessVars = (sliceGates: Gate[], variableIndexMapping: number[]) => {
	const nVariables = variableIndexMapping.length
	const cachedOutputs: boolean[][] = []
	const areCircuitsProbabilisticallyTheSame = (oldCircuit: Gate[], newCircuit: Gate[], attempts: number) => {
		for (let attempt = 0; attempt < attempts; attempt++) {
			const randomInput = randomInputs[attempt].slice(0, nVariables)
			if (cachedOutputs[attempt] === undefined) {
				cachedOutputs.push(evalCircuit(oldCircuit, randomInput))
			}
			const newOutput = evalCircuit(newCircuit, randomInput)
			if (!areBooleanArraysEqual(cachedOutputs[attempt], newOutput)) return false
		}
		return true
	}

	if (nVariables < 8) return undefined // no need to do this approach for less than 8 vars as we have exact way already
	const attempts = 102//getAttemptsToBeConfident(0.995, nVariables)+100
	const mappedGates = mapCircuit(sliceGates, variableIndexMapping)
	for (let variableIndex = 0; variableIndex < nVariables; variableIndex++) {
		const newCircuit = removeVariable(mappedGates, variableIndex)
		if (areCircuitsProbabilisticallyTheSame(mappedGates, newCircuit, attempts)) {
			//console.log(`ProbDelete variable v${ variableIndexMapping[variableIndex] }`)
			//console.log(`probabilistic vars: ${ nVariables }, attempts: ${ attempts }`)
			//console.log(`Probabilistic replace variable v${ variableIndexMapping[variableIndex] } -> v${ replacevalue } (${ nVariables } -> ${ nVariables - 1 })`)
			return reverseMapCircuit(newCircuit, variableIndexMapping)
		}
	}
	return undefined
}

const getAttemptsToBeConfident = (confidence: number, bits: number) => {
	//(1/2^bits)^N >= P
	return Math.ceil(-Math.log2(1-confidence) / bits + 1)
}

const BYTE_ALL_INPUTS = new Map<number, boolean[][]>([
	[4, generateCombinations(4)],
	[5, generateCombinations(5)],
	[6, generateCombinations(6)],
	[7, generateCombinations(7)],
])
const findUselessVars = (sliceGates: Gate[], variableIndexMapping: number[]) => {
	const nVariables = variableIndexMapping.length
	const allInputs = BYTE_ALL_INPUTS.get(nVariables)
	if (allInputs === undefined) return undefined
	const mappedGates = mapCircuit(sliceGates, variableIndexMapping)
	const expectedOutput = calculateAllOutputsArray(mappedGates, allInputs)
	for (let variableIndex = 0; variableIndex < nVariables; variableIndex++) {
		const newCircuit = removeVariable(mappedGates, variableIndex)
		if (areBooleanArraysEqual(expectedOutput, calculateAllOutputsArray(newCircuit, allInputs))) {
			//console.log(`Delete variable v${ variableIndexMapping[variableIndex] }`)
			return reverseMapCircuit(newCircuit, variableIndexMapping)
		}
	}
	return undefined
}

const insertArrayAtIndex = (originalArray: Gate[], newArray: Gate[], index: number): Gate[] => {
	if (index < 0 || index > originalArray.length) throw new Error('Index out of bounds')
	const before = originalArray.slice(0, index)
	const after = originalArray.slice(index)
	return [...before, ...newArray, ...after]
}

const RAINBOW_TABLE_WIRES = 4
const FOUR_BYTE_ALL_INPUTS = generateCombinations(RAINBOW_TABLE_WIRES)

const massOptimizeStep = async (db: sqlite3.Database, ioIdentifierCache: LimitedMap<string, Gate[] | null>, processedGatesCache: LimitedMap<string, boolean>, gates: Gate[], sliceSize: number, useProbabilistically: boolean, maxLoopTo: number, wires: number) => {
	const replacements: { start: number, end: number, replacement: Gate[] }[] = []
	let uselessVarsFound = 0
	let uselessVarsFoundProb = 0
	const endL = Math.min(gates.length - sliceSize, maxLoopTo)
	for (let a = 0; a <= endL; a++) {
		const start = a
		const end = a + sliceSize
		const sliceGates = gates.slice(start, end)
		const gatesHash = hashGates(sliceGates)
		if (processedGatesCache.has(gatesHash)) continue

		const variableIndexMapping = mapVariablesToIndexes(sliceGates, wires) // map variables to smaller amount of wires
		if (sliceSize > 2) {
			const replacement = findUselessVars(sliceGates, variableIndexMapping)
			if (replacement !== undefined) {
				replacements.push({ start, end: end - 1, replacement: gateSimplifier(replacement) })
				uselessVarsFound++
				a += sliceSize - 1 // increment by slice amount that we don't optimize the same part again
				continue
			}
			if (useProbabilistically) {
				const replacement = findProbabilisticUselessVars(sliceGates, variableIndexMapping)
				if (replacement !== undefined) {
					replacements.push({ start, end: end - 1, replacement: gateSimplifier(replacement) })
					uselessVarsFoundProb++
					a += sliceSize - 1 // increment by slice amount that we don't optimize the same part again
					continue
				}
			}
		}
		if (variableIndexMapping.length <= RAINBOW_TABLE_WIRES) {
			const mappedGates = mapCircuit(sliceGates, variableIndexMapping)
			const allOutputs = calculateAllOutputsArray(mappedGates, FOUR_BYTE_ALL_INPUTS)
			const ioIdentifier = ioHash(allOutputs)
			const rainbowMatch = await getReplacerById(db, ioIdentifierCache, ioIdentifier)
			if (rainbowMatch && rainbowMatch.replacerGates.length < sliceSize) { //replace if we find a match and its better
				replacements.push({
					start,
					end: end - 1,
					replacement: reverseMapCircuit(rainbowMatch.replacerGates, variableIndexMapping)
				})
				a += sliceSize - 1 // increment by slice amount that we don't optimize the same part again
				continue
			}
		}
		processedGatesCache.set(gatesHash, true)
	}
	if (replacements.length === 0) return { gates, changed: false }
	const newCircuit = replace(gates, replacements)
	const diff = gates.length - newCircuit.length
	console.log(`Removed ${ diff } gates, exact simplified ${ uselessVarsFound } vars, probabilistically simplified ${ uselessVarsFoundProb } vars. With slice ${ sliceSize }`)
	return { gates: newCircuit, changed: true }
}

const gateSimplifier = (gates: Gate[]) => gates.map((gate) => simplifyGate(gate))

function arrayOfRandomOrder(n: number): number[] {
	const numbers = Array.from({ length: n + 1 }, (_, i) => i)

	// Shuffle the array using Fisher-Yates algorithm
	for (let i = numbers.length - 1; i > 0; i--) {
		const randomIndex: number = Math.floor(Math.random() * (i + 1));
		[numbers[i], numbers[randomIndex]] = [numbers[randomIndex], numbers[i]]
	}
	return numbers
}

const VARIABLE_CREATION_GATE = -1
const optimize = async (db: sqlite3.Database, originalGates: Gate[], wires: number, problemName: string) => {
	let iterations = 0
	let optimizedVersion = originalGates.slice()
	let prevSavedLength = originalGates.length
	optimizedVersion = gateSimplifier(optimizedVersion)
	
	verifyCircuit(originalGates, optimizedVersion, wires, 20)
	let lastSaved = performance.now()
	const ioIdentifierCache = new LimitedMap<string, Gate[] | null>(1000000)
	const processedGatesCache = new LimitedMap<string, boolean>(1000000)
	console.log('Optimizer started')
	const bigSliceSize = 3000
	let sliceToUse = 2;
	let complete = false
	while (true) {
		let slicedVersion = optimizedVersion.slice(0, bigSliceSize)
		const dependencies = createDependencyGraph(slicedVersion, wires)
		//fs.writeFileSync(`${ problemName }.dependency.json`, getDependencyGraphAsStringWithGates(dependencies, optimizedVersion), 'utf8')
		const graphIterator = findConvexSubsets(dependencies, 2000, slicedVersion, wires)
		//fs.writeFileSync(`${ problemName }.iter.json`, graphIterator.map((x) => x.join(',')).join('\n'), 'utf8')
		for (const lines of graphIterator) {
			let continueRun = true
			const inGates = lines.map((x) => slicedVersion[x])
			for (let it = 2; it < 200; it++) {
				if (sliceToUse >= 200) sliceToUse = 2
				const optimizationOutput = await massOptimizeStep(db, ioIdentifierCache, processedGatesCache, inGates, sliceToUse, true, inGates.length, wires)
				sliceToUse++
				if (optimizationOutput.changed) {
					slicedVersion = insertArrayAtIndex(slicedVersion, optimizationOutput.gates, lines[lines.length-1]+1)
					slicedVersion = replace(slicedVersion, lines.map((l) => ({ start: l, end: l, replacement: [] })))
					continueRun = false
					break
				}
			}
			if (!continueRun) break
			complete = true
		}
		optimizedVersion = [...slicedVersion, ...optimizedVersion.slice(bigSliceSize, optimizedVersion.length)]
		if (prevSavedLength !== optimizedVersion.length || complete) {
			const endTime = performance.now()
			const timeDiffMins = (endTime - lastSaved) / 60000
			if (timeDiffMins >= 10 || complete) {
				prevSavedLength = optimizedVersion.length
				const filename = `${ problemName }.solved-${ optimizedVersion.length }.json`
				optimizedVersion = gateSimplifier(optimizedVersion)
				console.log(`Saving a version with ${ optimizedVersion.length } gates to ${ filename } (${ Math.floor(optimizedVersion.length/originalGates.length*100) }% of original)`)
				console.log(`Average gate complexity: ${ optimizedVersion.flatMap((gate) => getVars(gate, wires).length).reduce((a, c) => a + c, 0) / optimizedVersion.length }`)
				verifyCircuit(originalGates, optimizedVersion, wires, 20)
				fs.writeFileSync(filename, convertToOriginal(wires, optimizedVersion), 'utf8')
				lastSaved = endTime
			}
		}
		if (complete) return
		iterations++
	}
}

const run = async (pathToFileWithoutExt: string, verbose: boolean) => {
	console.log(`Started to run job ${ pathToFileWithoutExt }`)
	const db = await createRainbowTable(RAINBOW_TABLE_WIRES)
	const inputCircuit = readJsonFile(`${ pathToFileWithoutExt }.json`) as CircuitData
	console.log('wire_count', inputCircuit.wire_count)
	console.log('gate_count', inputCircuit.gates.length)
	const gates: Gate[] = inputCircuit.gates.map((x) => ({ a: x[0], b: x[1], target: x[2], gate_i: x[3] }))
	fs.writeFileSync(`${ pathToFileWithoutExt }.commands.json`, gatesToText(gates))
	/*writeDictionaryToFile(findSwappableLines(gates, gates.length), `${ pathToFileWithoutExt }.swappable.json`)
	const dependencies = createDependencyGraph(gates)
	fs.writeFileSync(`${ pathToFileWithoutExt }.dependency.json`, getDependencyGraphAsString(dependencies), 'utf8')
	const groups = groupTopologicalSort(dependencies)
	fs.writeFileSync(`${ pathToFileWithoutExt }.groups.json`, groups.join('\n'), 'utf8')
	*/
	//const depp = findGroupsThatDoNotDependFromOthers(dependencies)
	//fs.writeFileSync(`${ pathToFileWithoutExt }.depp.json`, depp.map((c) => c.join(',')).join('\n'), 'utf8')
	
	//fs.writeFileSync(`${ pathToFileWithoutExt }.dependencyEdge.json`, getDependencyGraphAsEdgesString(dependencies), 'utf8')
	


	//drawDependencyGraph(gates, inputCircuit.wire_count, `${ pathToFileWithoutExt }.dependency-graph.png`,8048, 1024)
	
	try {
		await optimize(db, gates, inputCircuit.wire_count, pathToFileWithoutExt)
	} catch(e: unknown) {
		console.error(e)
	}
}

if (process.argv.length !== 3) throw new Error('filename missing')
const { dir, name } = parse(process.argv[2])
const filePath = join(dir, name)
run(filePath, false)
