import * as fs from 'fs'
import sqlite3 from 'sqlite3'
import { createDependencyGraph, getDependencyGraphAsStringWithGates } from './lineswapper.js'
import { areBooleanArraysEqual, calculateAllOutputsArray, convertToOriginal, evalCircuit, findConvexSubsets, gatesToText, generateCombinations, generateNRandomBooleanArray, getRandomNumberInRange, getVars, hashGates, ioHash, mapCircuit, mapVariablesToIndexes, randomOrder, readJsonFile, replace, reverseMapCircuit, simplifyGate, verifyCircuit } from './utils.js'
import { CircuitData, Gate } from './types.js'
import { createRainbowTable, getReplacerById } from './rainbowtable.js'
import { LimitedMap } from './limitedMap.js'
import { join, parse } from 'path'
import { drawDependencyGraph } from './drawGraph.js'

const removeVariable = (gates: Gate[], variable: number) => {
	return gates.map((gate) => {
		if (gate.target === variable) return undefined
		const vars = getVars(gate)
		if (vars.length === 2 && vars[1] === variable) return undefined
		if (gate.a === variable) return simplifyGate({ ...gate, a: gate.b })
		if (gate.b === variable) return simplifyGate({ ...gate, b: gate.a })
		return gate
	}).filter((gate): gate is Gate => gate !== undefined)
}

const areCircuitsProbabilisticallyTheSame = (cachedOutputs: boolean[][], oldCircuit: Gate[], newCircuit: Gate[], attempts: number, nVariables: number) => {
	for (let attempt = 0; attempt < attempts; attempt++) {
		const randomInput = randomInputs[attempt].slice(0, nVariables)
		if (cachedOutputs[attempt] === undefined) cachedOutputs.push(evalCircuit(oldCircuit, randomInput))
		const newOutput = evalCircuit(newCircuit, randomInput)
		if (!areBooleanArraysEqual(cachedOutputs[attempt], newOutput)) return false
	}
	return true
}

const replaceVar = (gate: Gate, variableToReplace: number, variableToReplaceWith: number) => {
	return {
		a: gate.a === variableToReplace ? variableToReplaceWith : gate.a,
		b: gate.b === variableToReplace ? variableToReplaceWith : gate.b,
		target: gate.target === variableToReplace ? variableToReplaceWith : gate.target,
		gate_i: gate.gate_i
	}
}

const RAINBOW_TABLE_WIRES = 4
const RAINBOW_TABLE_GATES = 4
const RAINBOW_TABLE_ALL_INPUTS = generateCombinations(RAINBOW_TABLE_WIRES)
const MAX_DETERMINISTIC_USELESS_VARS = 8
const BYTE_ALL_INPUTS = new Map<number, boolean[][]>()
for (let wires = RAINBOW_TABLE_WIRES; wires < MAX_DETERMINISTIC_USELESS_VARS; wires++) {
	BYTE_ALL_INPUTS.set(wires, generateCombinations(wires))
}

const INPUTS = 202
const randomInputs = generateNRandomBooleanArray(INPUTS, 64)
const findProbabilisticUselessVars = (sliceGates: Gate[], variableIndexMapping: number[]) => {
	const nVariables = variableIndexMapping.length
	const cachedOutputs: boolean[][] = []
	
	if (nVariables < MAX_DETERMINISTIC_USELESS_VARS) return undefined // no need to do this approach for less than 8 vars as we have exact way already
	const newVars = randomOrder(nVariables)
	const mappedGates = mapCircuit(sliceGates, variableIndexMapping)
	if (areCircuitsProbabilisticallyTheSame(cachedOutputs, mappedGates, [], INPUTS, nVariables)) return []
	for (let variableIndex = 0; variableIndex < nVariables; variableIndex++) {
		const newCircuit = removeVariable(mappedGates, variableIndex)
		if (areCircuitsProbabilisticallyTheSame(cachedOutputs, mappedGates, newCircuit, INPUTS, nVariables)) {
			return reverseMapCircuit(newCircuit, variableIndexMapping)
		}
		for (const newVar of newVars) {
			//const newVar = getRandomNumberInRange(0, nVariables)
			if (variableIndexMapping[variableIndex] <= variableIndexMapping[newVar]) continue
			const newCircuit = mappedGates.map((gate) => replaceVar(gate, variableIndex, newVar))
			if (areCircuitsProbabilisticallyTheSame(cachedOutputs, mappedGates, newCircuit, INPUTS, nVariables)) {
				//console.log(`Pswap v${variableIndexMapping[variableIndex]} -> v${variableIndexMapping[newVar]}`)
				//console.log(gatesToText(sliceGates))
				//console.log('to')
				//console.log(gatesToText(reverseMapCircuit(newCircuit, variableIndexMapping)))
				return reverseMapCircuit(newCircuit, variableIndexMapping)
			}
		}
	}
	return undefined
}

const findUselessVars = (sliceGates: Gate[], variableIndexMapping: number[]) => {
	const nVariables = variableIndexMapping.length
	const allInputs = BYTE_ALL_INPUTS.get(nVariables)
	if (allInputs === undefined) return undefined
	const newVars = randomOrder(nVariables)
	const mappedGates = mapCircuit(sliceGates, variableIndexMapping)
	const expectedOutput = calculateAllOutputsArray(mappedGates, allInputs)
	if (areBooleanArraysEqual(expectedOutput, allInputs.flat())) return []
	for (let variableIndex = 0; variableIndex < nVariables; variableIndex++) {
		const newCircuit = removeVariable(mappedGates, variableIndex)
		if (areBooleanArraysEqual(expectedOutput, calculateAllOutputsArray(newCircuit, allInputs))) {
			return reverseMapCircuit(newCircuit, variableIndexMapping)
		}
		for (const newVar of newVars) {
			if (variableIndexMapping[variableIndex] <= variableIndexMapping[newVar]) continue
			const newCircuit = mappedGates.map((gate) => replaceVar(gate, variableIndex, newVar))
			if (areBooleanArraysEqual(expectedOutput, calculateAllOutputsArray(newCircuit, allInputs))) {
				//console.log(`swap v${variableIndexMapping[variableIndex]} -> v${variableIndexMapping[newVar]}`)
				//console.log(`swap v${variableIndexMapping[variableIndex]} -> v${variableIndexMapping[newVar]}`)
				//console.log(gatesToText(sliceGates))
				//console.log('to')
				//console.log(gatesToText(reverseMapCircuit(newCircuit, variableIndexMapping)))
				
				return reverseMapCircuit(newCircuit, variableIndexMapping)
			}
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

const massOptimizeStep = async (db: sqlite3.Database, ioIdentifierCache: LimitedMap<string, Gate[] | null>, processedGatesCache: LimitedMap<string, boolean>, gates: Gate[], sliceSize: number, useProbabilistically: boolean, findUselessVarsSetting: boolean): Promise<{ gates: Gate[], changed: boolean }> => {
	const replacements: { start: number, end: number, replacement: Gate[] }[] = []
	let uselessVarsFound = 0
	let uselessVarsFoundProb = 0
	for (let a = 0; a < gates.length - sliceSize; a++) {
		const start = a
		const end = a + sliceSize
		const sliceGates = gates.slice(start, end)
		const gatesHash = hashGates(sliceGates)
		if (processedGatesCache.has(gatesHash)) continue

		const variableIndexMapping = mapVariablesToIndexes(sliceGates) // map variables to smaller amount of wires
		if (sliceSize > 2 && findUselessVarsSetting) {
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
			const allOutputs = calculateAllOutputsArray(mappedGates, RAINBOW_TABLE_ALL_INPUTS)
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
		// store only ones that didn't produce any changes. As marking as processed means we don't process this sequence ever again, while we don't want to do that as we might face the same sequence of the gates again and we want to optimize it
		processedGatesCache.set(gatesHash, true)
	}
	if (replacements.length === 0) return { gates, changed: false }
	const newCircuit = replace(gates, replacements)
	const diff = gates.length - newCircuit.length
	console.log(`Removed ${ diff } gates, exact simplified ${ uselessVarsFound } vars, probabilistically simplified ${ uselessVarsFoundProb } vars. With slice ${ sliceSize }`)
	return { gates: newCircuit, changed: true }
}

const gateSimplifier = (gates: Gate[]) => gates.map((gate) => simplifyGate(gate))

const save = (problemName: string, gates: Gate[], wires: number, originalGates: Gate[]) => {
	const filename = `${ problemName }.solved-${ gates.length }.json`
	gates = gateSimplifier(gates)
	console.log(`Saving a version with ${ gates.length } gates to ${ filename } (${ Math.floor(gates.length/originalGates.length*100) }% of original)`)
	console.log(`Average gate complexity: ${ gates.flatMap((gate) => getVars(gate).length).reduce((a, c) => a + c, 0) / gates.length }`)
	verifyCircuit(originalGates, gates, wires, 20)
	fs.writeFileSync(filename, convertToOriginal(wires, gates), 'utf8')
}

const optimize = async (db: sqlite3.Database, originalGates: Gate[], wires: number, problemName: string) => {
	let optimizedVersion = originalGates.slice()
	let prevSavedLength = originalGates.length
	optimizedVersion = gateSimplifier(optimizedVersion)
	verifyCircuit(originalGates, optimizedVersion, wires, 20)
	let lastSaved = performance.now()
	const ioIdentifierCache = new LimitedMap<string, Gate[] | null>(1000000)
	const processedGatesCache = new LimitedMap<string, boolean>(1000000)
	console.log('Optimizer started')
	let subsetSize = 0
	let bigSliceSize = 100000
	let sliceEnd = bigSliceSize/2
	let maxSlice = 5
	let phase: 'simplest' | 'fast' | 'heavy' = 'simplest'
	let iterationsWithoutMatches = 0
	while (true) {
		let slicedVersion = optimizedVersion.slice(0, bigSliceSize)
		sliceEnd++
		if (sliceEnd > slicedVersion.length) sliceEnd = 2
		const graphIterator = findConvexSubsets(subsetSize, slicedVersion/*.slice(0, sliceEnd)*/)
		let continueRun = true
		for (let lines of graphIterator) {
			let sliceToUse = 1
			while(true) {
				const linesN = lines.length
				if (linesN === 0) break
				const inGates = lines.map((x) => slicedVersion[x])
				let it = 0
				for (;it < maxSlice; it++) {
					sliceToUse++
					if (sliceToUse > maxSlice) sliceToUse = 2
					if (sliceToUse > linesN) continue
					const optimizationOutput = await massOptimizeStep(db, ioIdentifierCache, processedGatesCache, inGates, sliceToUse, phase === 'heavy', phase === 'fast' || phase === 'heavy')
					if (optimizationOutput.changed) {
						slicedVersion = insertArrayAtIndex(slicedVersion, optimizationOutput.gates, lines[lines.length - 1] + 1)
						slicedVersion = replace(slicedVersion, lines.map((l) => ({ start: l, end: l, replacement: [] })))
						const offset = lines[lines.length - 1] + 1 - lines.length
						lines = Array.from(Array(optimizationOutput.gates.length).keys()).map((x) => x + offset)
						continueRun = false
						iterationsWithoutMatches = 0
						if (sliceToUse > 6) sliceToUse = 2
						break
					}
				}
				if (continueRun === false) {
					const endTime = performance.now()
					const timeDiffMins = (endTime - lastSaved) / 60000
					if (timeDiffMins >= 10) {
						let newVersion = [...slicedVersion, ...optimizedVersion.slice(bigSliceSize, optimizedVersion.length)]
						save(problemName, newVersion, wires, originalGates)
						prevSavedLength = newVersion.length
						lastSaved = endTime
					}
				}
				if (it === maxSlice) break
			}
			optimizedVersion = [...slicedVersion, ...optimizedVersion.slice(bigSliceSize, optimizedVersion.length)]
			verifyCircuit(originalGates, optimizedVersion, wires, 20)
			if (prevSavedLength !== optimizedVersion.length) {
				const endTime = performance.now()
				const timeDiffMins = (endTime - lastSaved) / 60000
				if (timeDiffMins >= 10) {
					save(problemName, optimizedVersion, wires, originalGates)
					lastSaved = endTime
					prevSavedLength = optimizedVersion.length
				}
			}
			if (!continueRun) break
		}
		iterationsWithoutMatches++
		if (iterationsWithoutMatches > 1 && phase === 'simplest') {
			// went long time without matches, lets make searches heavier
			console.log('moved to Fast phase')
			maxSlice = 7
			subsetSize = 200
			phase = 'fast'
			bigSliceSize = 10000
			iterationsWithoutMatches = 0
		}
		if (iterationsWithoutMatches > 1 && phase === 'fast') {
			// went long time without matches, lets make searches heavier
			console.log('moved to Heavy phase')
			subsetSize = 300
			maxSlice = 100
			phase = 'heavy'
			iterationsWithoutMatches = 0
			bigSliceSize = optimizedVersion.length
		}
		if (iterationsWithoutMatches > 1) break
	}
	const filename = `${ problemName }.FINAL-${ optimizedVersion.length }.json`
	console.log(`Saving a version with ${ optimizedVersion.length } gates to ${ filename } (${ Math.floor(optimizedVersion.length/originalGates.length*100) }% of original)`)
	console.log(`Average gate complexity: ${ optimizedVersion.flatMap((gate) => getVars(gate).length).reduce((a, c) => a + c, 0) / optimizedVersion.length }`)
	verifyCircuit(originalGates, optimizedVersion, wires, 20)
	fs.writeFileSync(filename, convertToOriginal(wires, optimizedVersion), 'utf8')
}

const run = async (pathToFileWithoutExt: string) => {
	console.log(`Started to run job ${ pathToFileWithoutExt }`)
	const db = await createRainbowTable(RAINBOW_TABLE_WIRES, RAINBOW_TABLE_GATES)
	const inputCircuit = readJsonFile(`${ pathToFileWithoutExt }.json`) as CircuitData
	console.log('wire_count', inputCircuit.wire_count)
	console.log('gate_count', inputCircuit.gates.length)
	const gates: Gate[] = inputCircuit.gates.map((x) => ({ a: x[0], b: x[1], target: x[2], gate_i: x[3] }))
	fs.writeFileSync(`${ pathToFileWithoutExt }.commands.json`, gatesToText(gates))
	const gatesToGraph = 3000
	drawDependencyGraph(gates.slice(0, gatesToGraph), `${ pathToFileWithoutExt }.dependency-graph.SLICE.png`, 32000, 4000)
	const dependencies = createDependencyGraph(gates.slice(0, gatesToGraph))
	fs.writeFileSync(`${ pathToFileWithoutExt }.dependency.SLICE.json`, getDependencyGraphAsStringWithGates(dependencies, gates), 'utf8')
	try {
		await optimize(db, gates, inputCircuit.wire_count, pathToFileWithoutExt)
	} catch(e: unknown) {
		console.error(e)
	}
}

if (process.argv.length !== 3) throw new Error('filename missing')
const { dir, name } = parse(process.argv[2])
const filePath = join(dir, name)
run(filePath)
