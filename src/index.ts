import * as fs from 'fs'
import sqlite3 from 'sqlite3'
import { createDependencyGraph, findSwappableLines, getDependencyGraphAsString, shuffleLinesWithinGroups } from './lineswapper.js'
import { areBooleanArraysEqual, assertNever, calculateAllOutputsArray, convertToOriginal, evalCircuit, gatesToText, generateCombinations, generateRandomBooleanArray, getControlFunc, getRandomNumberInRange, getVars, hashNumberArray, ioHash, mapCircuit, mapVariablesToIndexes, readJsonFile, replace, reverseMapCircuit, simplifyGateOperatorIfGatesMatch, verifyCircuit, writeDictionaryToFile } from './utils.js'
import { CircuitData, Gate } from './types.js'
import { createRainbowTable, getReplacerById } from './rainbowtable.js'
import { LimitedMap } from './limitedMap.js'
import { findCriticalPath, groupTopologicalSort } from './cycles.js'
import { join, parse } from 'path'

const BYTE_ALL_INPUTS = new Map<number, boolean[][]>([
	[4, generateCombinations(4)],
	[5, generateCombinations(5)],
	[6, generateCombinations(6)],
	[7, generateCombinations(7)],
])
const findProbabilisticUselessVars = (sliceGates: Gate[], variableIndexMapping: number[]) => {
	const areCircuitsProbabilisticallyTheSame = (oldCircuit: Gate[], newCircuit: Gate[], attempts: number) => {
		for (let attempt = 0; attempt < attempts; attempt++) {
			const randomInput = generateRandomBooleanArray(nVariables)
			const oldOutput = evalCircuit(oldCircuit, randomInput)
			const newOutput = evalCircuit(newCircuit, randomInput)
			if (!areBooleanArraysEqual(oldOutput, newOutput)) return false
		}
		return true
	}
	
	const nVariables = variableIndexMapping.length
	if (nVariables < 8) return undefined // no need to do this approach for less than 8 vars as we have exact way already
	if (nVariables > 32) return undefined // try max 32
	const attempts = getAttemptsToBeConfident(0.995, nVariables)+100
	const mappedGates = mapCircuit(sliceGates, variableIndexMapping)
	for (let variableIndex = 0; variableIndex < nVariables; variableIndex++) {
		const replacevalue = variableIndexMapping[(variableIndex + 1) % nVariables]
		const newMapping = variableIndexMapping.map((value, i) => i === variableIndex ? replacevalue : value)
		const newCircuit = mapCircuit(reverseMapCircuit(mappedGates, newMapping), variableIndexMapping)
		if (areCircuitsProbabilisticallyTheSame(mappedGates, newCircuit, attempts)) {
			console.log(`probabilistic vars: ${ nVariables }, attempts: ${ attempts }`)
			console.log(`Probabilistic replace variable v${ variableIndexMapping[variableIndex] } -> v${ replacevalue } (${ nVariables } -> ${ nVariables - 1 })`)
			return reverseMapCircuit(mappedGates, newMapping)
		}
	}
	return undefined
}

const getAttemptsToBeConfident = (confidence: number, bits: number) => {
	//(1/2^bits)^N >= P
	return Math.ceil(-Math.log2(1-confidence) / bits + 1)
}

const findUselessVars = (sliceGates: Gate[], variableIndexMapping: number[]) => {
	const nVariables = variableIndexMapping.length
	const allInputs = BYTE_ALL_INPUTS.get(nVariables)
	if (allInputs === undefined) return undefined
	const mappedGates = mapCircuit(sliceGates, variableIndexMapping)
	const expectedOutput = calculateAllOutputsArray(mappedGates, allInputs)
	for (let variableIndex = 0; variableIndex < nVariables; variableIndex++) {
		const replacevalue = variableIndexMapping[(variableIndex + 1) % nVariables]
		const newMapping = variableIndexMapping.map((value, i) => i === variableIndex ? replacevalue : value)
		const newCircuit = mapCircuit(reverseMapCircuit(mappedGates, newMapping), variableIndexMapping)
		if (areBooleanArraysEqual(expectedOutput, calculateAllOutputsArray(newCircuit, allInputs))) {
			console.log(`Replace variable v${ variableIndexMapping[variableIndex] } -> v${ replacevalue } (${ nVariables } -> ${ nVariables - 1 })`)
			return reverseMapCircuit(mappedGates, newMapping)
		}
	}
	return undefined
}

const criticalPathOptimizer = async (db: sqlite3.Database, ioIdentifierCache: LimitedMap<string, Gate[] | null>, gates: Gate[], sliceSize: number, uniqueCriticalPaths: number[][], useProbabilistically: boolean): Promise<{ changed: boolean, gates: Gate[] }> => {
	const insertArrayAtIndex = (originalArray: Gate[], newArray: Gate[], index: number): Gate[] => {
		if (index < 0 || index > originalArray.length) {
			throw new Error('Index out of bounds')
		}
	
		const before = originalArray.slice(0, index)
		const after = originalArray.slice(index)
	
		return [...before, ...newArray, ...after]
	}
	
	const processedSegment = new Set<string>()
	for (const lineNumbers of uniqueCriticalPaths) {
		for (let a = 0; a < lineNumbers.length - sliceSize; a++) {
			const chosenLines = lineNumbers.slice(a, a+sliceSize)
			const segmentHash = hashNumberArray(chosenLines)
			if (processedSegment.has(segmentHash)) continue
			processedSegment.add(segmentHash)
			const sliceGates = chosenLines.map((l) => gates[l])
			const firstRow = chosenLines[0]
			const variableIndexMapping = mapVariablesToIndexes(sliceGates) // map variables to smaller amount of wires
			if (variableIndexMapping.length >= RAINBOW_TABLE_WIRES) {
				const replacement = findUselessVars(sliceGates, variableIndexMapping)
				if (replacement !== undefined) {
					const oldremoved = replace(gates, chosenLines.map((l) => ({ start: l, end: l, replacement: [] })))
					const newCircuit = insertArrayAtIndex(oldremoved, gateSimplifier(replacement), firstRow)
					console.log(`Simplified 1 vars. With slice ${ sliceSize }`)
					return { changed: true, gates: newCircuit }
				}
				if (useProbabilistically) {
					const replacement = findProbabilisticUselessVars(sliceGates, variableIndexMapping)
					if (replacement !== undefined) {
						const oldremoved = replace(gates, chosenLines.map((l) => ({ start: l, end: l, replacement: [] })))
						const newCircuit = insertArrayAtIndex(oldremoved, gateSimplifier(replacement), firstRow)
						console.log(`Probabilistically simplified 1 vars. With slice ${ sliceSize }`)
						return { changed: true, gates: newCircuit }
					}
				}
			}
			
			if (variableIndexMapping.length > RAINBOW_TABLE_WIRES) continue
			const mappedGates = mapCircuit(sliceGates, variableIndexMapping)
			const allOutputs = calculateAllOutputsArray(mappedGates, FOUR_BYTE_ALL_INPUTS)
			const ioIdentifier = ioHash(allOutputs)
			const rainbowMatch = await getReplacerById(db, ioIdentifierCache, ioIdentifier)
			if (rainbowMatch && rainbowMatch.replacerGates.length < chosenLines.length) { //replace if we find a match and its better
				const replacement = reverseMapCircuit(rainbowMatch.replacerGates, variableIndexMapping)
				const oldremoved = replace(gates, chosenLines.map((l) => ({ start: l, end: l, replacement: [] })))
				const newCircuit = insertArrayAtIndex(oldremoved, replacement, firstRow)
				const diff = gates.length - newCircuit.length
				console.log(`Removed ${ diff } gates (${ gates.length } -> ${ newCircuit.length }). With slice ${ sliceSize }`)
				return { changed: true, gates: newCircuit }
			}
		}
	}
	return { changed: false, gates }
}

const RAINBOW_TABLE_WIRES = 4
const FOUR_BYTE_ALL_INPUTS = generateCombinations(RAINBOW_TABLE_WIRES)

const massOptimizeStep = async (db: sqlite3.Database, ioIdentifierCache: LimitedMap<string, Gate[] | null>, gates: Gate[], sliceSize: number, verbose: boolean) => {
	const replacements: { start: number, end: number, replacement: Gate[] }[] = []
	let uselessVarsFound = 0
	for (let a = 0; a < gates.length - sliceSize; a++) {
		const start = a
		const end = a + sliceSize
		const sliceGates = gates.slice(start, end)
		const variableIndexMapping = mapVariablesToIndexes(sliceGates) // map variables to smaller amount of wires
		if (sliceSize > 2) {
			const replacement = findUselessVars(sliceGates, variableIndexMapping)
			if (replacement !== undefined) {
				replacements.push({ start, end: end - 1, replacement: gateSimplifier(replacement) })
				uselessVarsFound++
				a += sliceSize - 1 // increment by slice amount that we don't optimize the same part again
				continue
			}
		}
		if (variableIndexMapping.length > RAINBOW_TABLE_WIRES) continue
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
		}
	}
	if (replacements.length === 0) return { gates, changed: false }
	const newCircuit = replace(gates, replacements)
	const diff = gates.length - newCircuit.length
	console.log(`Removed ${ diff } gates (${ gates.length } -> ${ newCircuit.length }) and simplified ${ uselessVarsFound } vars. With slice ${ sliceSize }`)
	return { gates: newCircuit, changed: true }
}

const gateSimplifier = (gates: Gate[]) => {
	return gates.map((gate) => {
		const newGateIndex = simplifyGateOperatorIfGatesMatch(gate)
		if (newGateIndex !== gate.gate_i) {
			console.log(`Simplified gate "${ getControlFunc(gate.gate_i) }" -> "${ getControlFunc(newGateIndex) }"`)
			return { ...gate, gate_i: newGateIndex }
		}
		return gate
	})
}

type Stages = 'MassOptimizer' | 'CriticalPathOptimizer' | 'CriticalPathOptimizerWithProbabilistic'
const optimize = async (db: sqlite3.Database, originalGates: Gate[], wires: number, problemName: string, verbose: boolean, startStage: Stages) => {
	let iterations = 0
	let optimizedVersion = originalGates.slice()
	let prevSavedLength = originalGates.length
	optimizedVersion = gateSimplifier(optimizedVersion)
	let lastSaved = performance.now()
	const ioIdentifierCache = new LimitedMap<string, Gate[] | null>(1000000)
	let optimizerState = startStage
	console.log('Optimizer started')
	while (true) {
		// mass optimizer, scans throught everything
		switch(optimizerState) {
			case 'MassOptimizer': {
				let failedToOptimize = true
				const MAX_SLICES = 20
				for (let sliceToUse = 2; sliceToUse < MAX_SLICES; sliceToUse++) {
					const optimizationOutput = await massOptimizeStep(db, ioIdentifierCache, optimizedVersion, sliceToUse, verbose)
					if (optimizationOutput.changed) {
						optimizedVersion = optimizationOutput.gates
						failedToOptimize = false
						break
					}
					// shuffle every second time with small max group size to move group boundaries around
					const swapLines = iterations % 2 ? findSwappableLines(optimizedVersion, getRandomNumberInRange(2, 3)) : findSwappableLines(optimizedVersion, 100000)
					optimizedVersion = shuffleLinesWithinGroups(optimizedVersion, swapLines)
				}
				if (failedToOptimize) {
					console.log('change to OneThingOptimizer')
					optimizerState = 'CriticalPathOptimizer' // change optimizer when the mass thing fails once to find anything
				}
				break
			}
			case 'CriticalPathOptimizerWithProbabilistic':
			case 'CriticalPathOptimizer': {
				// tries to find one thing to optimize
				const dependencies = createDependencyGraph(optimizedVersion)
				//const variableIndex = iterations % wires
				//const lastVariableEditLine = optimizedVersion.length - 1 - optimizedVersion.slice().reverse().findIndex((x) => x.target === variableIndex)
				const lastVariableEditLine = iterations % (dependencies.length - 2) + 2
				const criticalPathToVariable = findCriticalPath(dependencies.slice(0, lastVariableEditLine))
				const uniqueCriticalPaths = [criticalPathToVariable]
				const probabilistic = optimizerState === 'CriticalPathOptimizerWithProbabilistic'
				const slices = [1000,100,50,20,10,8,7,6,5,4,3,2]
				for (const sliceToUse of slices) {
					const optimizationOutput = await criticalPathOptimizer(db, ioIdentifierCache, optimizedVersion, sliceToUse, uniqueCriticalPaths, probabilistic)
					if (optimizationOutput.changed) {
						optimizedVersion = optimizationOutput.gates
						break
					}
				}
				break
			}
			default: assertNever(optimizerState)

		}
		verifyCircuit(originalGates, optimizedVersion, 64, 20)
		if (prevSavedLength !== optimizedVersion.length) {
			const endTime = performance.now()
			const timeDiffMins = (endTime - lastSaved) / 60000
			if (timeDiffMins >= 10) {
				prevSavedLength = optimizedVersion.length
				const filename = `${ problemName }.solved-${ iterations }.json`
				optimizedVersion = gateSimplifier(optimizedVersion)
				console.log(`Saving a version with ${ optimizedVersion.length } gates to ${ filename } (${ Math.floor(optimizedVersion.length/originalGates.length*100) }% of original)`)
				console.log(`Average gate complexity: ${ optimizedVersion.flatMap((gate) => getVars(gate).length).reduce((a, c) => a + c, 0) / optimizedVersion.length }`)
				verifyCircuit(originalGates, optimizedVersion, wires, 20)
				fs.writeFileSync(filename, convertToOriginal(wires, optimizedVersion), 'utf8')
				lastSaved = endTime
			}
		}
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
	/*fs.writeFileSync(`${ pathToFileWithoutExt }.commands.json`, gatesToText(gates))
	writeDictionaryToFile(findSwappableLines(gates, gates.length), `${ pathToFileWithoutExt }.swappable.json`)
	const dependencies = createDependencyGraph(gates)
	fs.writeFileSync(`${ pathToFileWithoutExt }.dependency.json`, getDependencyGraphAsString(dependencies), 'utf8')
	const groups = groupTopologicalSort(dependencies)
	fs.writeFileSync(`${ pathToFileWithoutExt }.groups.json`, groups.join('\n'), 'utf8')
	*/
	//const depp = findGroupsThatDoNotDependFromOthers(dependencies)
	//fs.writeFileSync(`${ pathToFileWithoutExt }.depp.json`, depp.map((c) => c.join(',')).join('\n'), 'utf8')
	
	//fs.writeFileSync(`${ pathToFileWithoutExt }.dependencyEdge.json`, getDependencyGraphAsEdgesString(dependencies), 'utf8')
	


	//drawDependencyGraph(dependencies, `${ pathToFileWithoutExt }.dependency-graph.png`,8048, 8048)
	
	try {
		await optimize(db, gates, inputCircuit.wire_count, pathToFileWithoutExt, verbose, 'CriticalPathOptimizerWithProbabilistic')
	} catch(e: unknown) {
		console.error(e)
	}
}

if (process.argv.length !== 3) throw new Error('filename missing')
const { dir, name } = parse(process.argv[2])
const filePath = join(dir, name)
run(filePath, false)
