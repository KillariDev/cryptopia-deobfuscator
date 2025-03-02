import * as fs from 'fs'
import sqlite3 from 'sqlite3'
import { areBooleanArraysEqual, calculateAllOutputsArray, chunkArray, convertToOriginal, evalCircuit, findConvexSubsets, generateCombinations, generateNRandomBooleanArray, getRandomNumberInRange, getUniqueVars, getVars, hashGates, ioHash, logTimed, mapCircuit, mapVariablesToIndexes, randomOrder, readJsonFile, remove, replace, reverseMapCircuit, simplifyGate, verifyCircuit } from './utils.js'
import { CircuitData, Gate } from './types.js'
import { getReplacersByIds } from './rainbowtable.js'
import { LimitedMap } from './limitedMap.js'
import { runWorker } from './threads.js'

const removeVariable = (gates: Gate[], variable: number) => {
	return gates.map((gate) => {
		if (gate.target === variable) return undefined
		const vars = getVars(gate)
		if (vars.length === 2 && vars[1] === variable) return undefined
		if (gate.a === variable) {
			const simplified = simplifyGate({ ...gate, a: gate.b })
			if (simplified.gate_i === 0) return undefined // false gate that is identity gate, we can just remove it
			return simplified
		}
		if (gate.b === variable) {
			const simplified = simplifyGate({ ...gate, b: gate.a })
			if (simplified.gate_i === 0) return undefined // false gate that is identity gate, we can just remove it
			return simplified
		}
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

const MAX_DETERMINISTIC_USELESS_VARS = 8
const BYTE_ALL_INPUTS = new Map<number, boolean[][]>()
for (let wires = 2; wires < MAX_DETERMINISTIC_USELESS_VARS; wires++) {
	BYTE_ALL_INPUTS.set(wires, generateCombinations(wires))
}

const INPUTS = 202
const randomInputs = generateNRandomBooleanArray(INPUTS, 64)
const findProbabilisticUselessVars = (sliceGates: Gate[], variableIndexMapping: number[]) => {
	const nVariables = variableIndexMapping.length
	const cachedOutputs: boolean[][] = []
	if (nVariables < MAX_DETERMINISTIC_USELESS_VARS) return undefined // no need to do this approach for less than 8 vars as we have exact way already
	const mappedGates = mapCircuit(sliceGates, variableIndexMapping)
	if (areCircuitsProbabilisticallyTheSame(cachedOutputs, mappedGates, [], INPUTS, nVariables)) return []
	for (let variableIndex = 0; variableIndex < nVariables; variableIndex++) {
		const newCircuit = removeVariable(mappedGates, variableIndex)
		if (areCircuitsProbabilisticallyTheSame(cachedOutputs, mappedGates, newCircuit, INPUTS, nVariables)) {
			return reverseMapCircuit(newCircuit, variableIndexMapping)
		}
		for (let newVar = 0; newVar < nVariables; newVar++) {
			if (variableIndexMapping[variableIndex] <= variableIndexMapping[newVar]) continue
			const newCircuit = mappedGates.map((gate) => replaceVar(gate, variableIndex, newVar))
			if (areCircuitsProbabilisticallyTheSame(cachedOutputs, mappedGates, newCircuit, INPUTS, nVariables)) {
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

const optimizeVariables = (processedGatesCache: LimitedMap<string, boolean>, gates: Gate[], sliceSize: number, useProbabilistically: boolean, findUselessVarsSetting: boolean, rainbowTableWires: number): { gates: Gate[], changed: boolean } => {
	const replacements: { start: number, end: number, replacement: Gate[] }[] = []
	
	let uselessVarsFound = 0
	let uselessVarsFoundProb = 0
	if (sliceSize <= 2 || !findUselessVarsSetting) return { gates, changed: false }
	for (let a = 0; a < gates.length - sliceSize; a++) {
		const start = a
		const end = a + sliceSize
		const sliceGates = gates.slice(start, end)
		const gatesHash = hashGates(sliceGates)
		if (processedGatesCache.has(gatesHash)) continue

		const variableIndexMapping = mapVariablesToIndexes(sliceGates) // map variables to smaller amount of wires
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
		if (variableIndexMapping.length <= rainbowTableWires) continue
		processedGatesCache.set(gatesHash, true)
	}
	if (replacements.length === 0) return { gates, changed: false }
	const newCircuit = replace(gates, replacements)
	const diff = gates.length - newCircuit.length
	logTimed(`VAR: Removed ${ diff } gates, exact simplified ${ uselessVarsFound } vars, probabilistically simplified ${ uselessVarsFoundProb } vars. With slice ${ sliceSize }`)
	return { gates: newCircuit, changed: true }
}

const massOptimizeStep = async (db: sqlite3.Database, ioIdentifierCache: LimitedMap<string, Gate[] | null>, processedGatesCache: LimitedMap<string, boolean>, originalGates: Gate[], sliceSize: number, useProbabilistically: boolean, findUselessVarsSetting: boolean, rainbowTableWires: number, RAINBOW_TABLE_ALL_INPUTS: boolean[][]): Promise<{ gates: Gate[], changed: boolean }> => {
	const changes = optimizeVariables(processedGatesCache, originalGates, sliceSize, useProbabilistically, findUselessVarsSetting, rainbowTableWires)
	const gates = changes.gates
	const queries: { gatesHash: string, ioIdentifier: string, start: number, end: number, variableIndexMapping: number[] }[] = []
	const replacements: { start: number, end: number, replacement: Gate[] }[] = []
	for (let a = 0; a < gates.length - sliceSize; a++) {
		const start = a
		const end = a + sliceSize
		const sliceGates = gates.slice(start, end)
		const gatesHash = hashGates(sliceGates)
		if (processedGatesCache.has(gatesHash)) continue

		const variableIndexMapping = mapVariablesToIndexes(sliceGates) // map variables to smaller amount of wires
		if (variableIndexMapping.length <= rainbowTableWires) {
			const mappedGates = mapCircuit(sliceGates, variableIndexMapping)
			const allOutputs = calculateAllOutputsArray(mappedGates, RAINBOW_TABLE_ALL_INPUTS)
			const ioIdentifier = ioHash(allOutputs)
			queries.push({ gatesHash, ioIdentifier, start, end: end - 1, variableIndexMapping })
		}
	}
	const rainbowMatches = await getReplacersByIds(db, ioIdentifierCache, queries.map((x) => x.ioIdentifier))
	const rainbowMap = new Map<String, Gate[]>()
	rainbowMatches.forEach((entry) => { rainbowMap.set(entry.ioIdentifier, entry.gates) })
	let currentIndex = 0
	for (let query of queries) {
		const match = rainbowMap.get(query.ioIdentifier)
		if (match === undefined || (match.length === sliceSize && getUniqueVars(match).length >= query.variableIndexMapping.length)) {
			processedGatesCache.set(query.gatesHash, true)
			continue
		}
		if (query.start > currentIndex && (match.length < sliceSize || (match.length === sliceSize && getUniqueVars(match).length < query.variableIndexMapping.length))) {
			currentIndex = query.end
			replacements.push({
				start: query.start,
				end: query.end,
				replacement: reverseMapCircuit(match, query.variableIndexMapping)
			})
		}
	}
	if (replacements.length === 0) return changes
	const newCircuit = replace(gates, replacements)
	const diff = gates.length - newCircuit.length
	logTimed(`Rainbow: Removed ${ diff } gates with slice ${ sliceSize }`)
	return { gates: newCircuit, changed: true }
}

const gateSimplifier = (gates: Gate[]) => gates.map((gate) => simplifyGate(gate))

const save = (filename: string, gates: Gate[], wires: number, originalGates: Gate[]) => {
	gates = gateSimplifier(gates)
	logTimed(`Saving a version with ${ gates.length } gates to ${ filename } (${ Math.floor(gates.length/originalGates.length*100) }% of original)`)
	logTimed(`Average gate complexity: ${ gates.flatMap((gate) => getVars(gate).length).reduce((a, c) => a + c, 0) / gates.length }`)
	verifyCircuit(originalGates, gates, wires, 20)
	fs.writeFileSync(filename, convertToOriginal(wires, gates), 'utf8')
}

export function shuffleRows(gates: Gate[], times: number) {
	const hasCommonNumber = (arr1: number, arr2: number[]): boolean => {
		return arr2.includes(arr1)
	}

	for (let time = 0; time < times; time++) {
		for (let gateI = 1; gateI < gates.length; gateI++) {
			if (Math.random() < 0.5) continue
			const [thisAssigned, ...thisOthers] = getVars(gates[gateI])
			const [previousAssigned, ...previousOthers] = getVars(gates[gateI - 1])
			if (hasCommonNumber(thisAssigned, [previousAssigned, ...previousOthers])) continue
			if (hasCommonNumber(previousAssigned, [thisAssigned, ...thisOthers])) continue
			const prevGate = gates[gateI - 1]
			gates[gateI - 1] = gates[gateI]
			gates[gateI] = prevGate
		}
	}
}

const optimizeSubset = async (db: sqlite3.Database, slicedVersion: Gate[], ioIdentifierCache: LimitedMap<string, Gate[] | null>, processedGatesCache: LimitedMap<string, boolean>, subsetSize: number, maxSlice: number, phase: 'simplest' | 'fast' | 'heavy', timeToEndWorker: () => boolean, rainbowTableWires: number, rainbowTableAllInputs: boolean[][]): Promise<Gate[]> => {
	let graphIterator = findConvexSubsets(subsetSize, slicedVersion)
	let regenerateGraph = false
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
				if (timeToEndWorker()) return slicedVersion
				const optimizationOutput = await massOptimizeStep(db, ioIdentifierCache, processedGatesCache, inGates, sliceToUse, phase === 'heavy', phase === 'heavy', rainbowTableWires, rainbowTableAllInputs)
				if (optimizationOutput.changed) {
					slicedVersion = insertArrayAtIndex(slicedVersion, optimizationOutput.gates, lines[lines.length - 1] + 1)
					slicedVersion = remove(slicedVersion, lines)
					const offset = lines[lines.length - 1] + 1 - lines.length
					lines = Array.from(Array(optimizationOutput.gates.length).keys()).map((x) => x + offset)
					regenerateGraph = true
					sliceToUse = 1
					break
				}
			}
			if (it === maxSlice) break
		}
		if (regenerateGraph) {
			graphIterator = findConvexSubsets(subsetSize, slicedVersion)
			regenerateGraph = false
		}
	}
	return slicedVersion
}

export const optimize = async (db: sqlite3.Database, originalGates: Gate[], wires: number, problemName: string, workerMode: boolean, rainbowTableWires: number) => {
	let optimizedVersion = originalGates.slice()
	let prevSavedLength = originalGates.length
	optimizedVersion = gateSimplifier(optimizedVersion)
	verifyCircuit(originalGates, optimizedVersion, wires, 20)
	let lastSaved = performance.now()
	const ioIdentifierCache = new LimitedMap<string, Gate[] | null>(1000000)
	const processedGatesCache = new LimitedMap<string, boolean>(1000000)
	
	const rainbowTableAllInputs = generateCombinations(rainbowTableWires)
	logTimed('Optimizer started')
	let subsetSize = 6
	let maxSlice = 6
	let phase: 'simplest' | 'fast' | 'heavy' = 'heavy'
	const timeToEndWorker = () => {
		const endTime = performance.now()
		const timeDiffMins = (endTime - lastSaved) / 60000
		return timeDiffMins >= 20
	}
	while (true) {
		shuffleRows(optimizedVersion, 3)
		const sliceStart = Math.min(optimizedVersion.length -1, Math.max(0, getRandomNumberInRange(Math.floor(-optimizedVersion.length / 5), optimizedVersion.length)))
		const useCloseRange = Math.random() < 0.9 // 90% chance of using a close range
		const sliceEnd = Math.min(optimizedVersion.length, Math.max(0, useCloseRange ? getRandomNumberInRange(sliceStart, Math.min(sliceStart + Math.floor(optimizedVersion.length / 10), optimizedVersion.length)) : getRandomNumberInRange(sliceStart, Math.ceil(optimizedVersion.length * 105 / 100))))
		if (sliceEnd <= sliceStart) continue
		let slicedVersion = optimizedVersion.slice(sliceStart, sliceEnd)
		const nChunks = 5
		if (slicedVersion.length < nChunks * 10) continue
		logTimed(`Data selection: ${ Math.floor(sliceStart / optimizedVersion.length * 100) }% - ${ Math.floor(sliceEnd / optimizedVersion.length * 100) }%: ${ slicedVersion.length } gates`)
		
		const chunked = chunkArray(slicedVersion, nChunks)
		slicedVersion = (await Promise.all(chunked.flatMap(async (data) => optimizeSubset(db, data, ioIdentifierCache, processedGatesCache, subsetSize, maxSlice, phase, timeToEndWorker, rainbowTableWires, rainbowTableAllInputs)))).flat()
		
		optimizedVersion = [...optimizedVersion.slice(0, sliceStart), ...slicedVersion, ...optimizedVersion.slice(sliceEnd, optimizedVersion.length)]
		
		const gatesRemoved = prevSavedLength - optimizedVersion.length
		if (workerMode) {
			if (timeToEndWorker()) {
				logTimed(`Total Removed Gates Since Terminating: ${ gatesRemoved }`)
				save(problemName, optimizedVersion, wires, originalGates)
				return
			}
		} else {
			if (gatesRemoved > 0) {
				const endTime = performance.now()
				const timeDiffMins = (endTime - lastSaved) / 60000
				if (timeDiffMins >= 3) {
					logTimed(`Total Removed Gates Since last save: ${ gatesRemoved }`)
					const filename = `${ problemName }.solved-${ optimizedVersion.length }.json`
					save(filename, optimizedVersion, wires, originalGates)
					lastSaved = endTime
					prevSavedLength = optimizedVersion.length
				}
			}
		}
	}
}

export const splitTaskAndRun = async (pathToFileWithoutExt: string) => {
	const splitArrayIntoApproximatelyChunks = (arr: Gate[], n: number): Gate[][] => {
		if (n <= 0) throw new Error('Number of chunks must be greater than 0')
		if (n > arr.length) throw new Error('Number of chunks cannot exceed array length')
	
		const avgSize = arr.length / n
		const minSize = Math.floor(avgSize * 0.9)
		const maxSize = Math.ceil(avgSize * 1.1)
	
		const result: Gate[][] = []
		let index = 0
	
		for (let i = 0; i < n; i++) {
			const remainingChunks = n - i
			const remainingElements = arr.length - index
			const maxPossibleSize = Math.min(maxSize, Math.ceil(remainingElements / remainingChunks))
			const minPossibleSize = Math.max(minSize, Math.floor(remainingElements / remainingChunks))
			const chunkSize = Math.floor(Math.random() * (maxPossibleSize - minPossibleSize + 1)) + minPossibleSize
	
			result.push(arr.slice(index, index + chunkSize))
			index += chunkSize
		}
	
		return result
	}

	const inputCircuit = readJsonFile(`${ pathToFileWithoutExt }.json`) as CircuitData
	const gates: Gate[] = inputCircuit.gates.map((x) => ({ a: x[0], b: x[1], target: x[2], gate_i: x[3] }))
	const nMaxWorkers = 12
	let currentGates = gates.slice()
	while(true) {
		const nPrevGates = currentGates.length
		const nWorkers = Math.min(currentGates.length / 4000, nMaxWorkers)
		shuffleRows(currentGates, 20)
		const approxGates = splitArrayIntoApproximatelyChunks(currentGates, nWorkers)
		await Promise.all(approxGates.map(async (dataChunk, index) => {
			const workerFile = `${ pathToFileWithoutExt}_worker${index}.json`
			fs.writeFileSync(workerFile, convertToOriginal(inputCircuit.wire_count, dataChunk), 'utf8')
			await runWorker(workerFile)
		}))
		currentGates = approxGates.flatMap((_, index) => {
			const inputCircuit = readJsonFile(`${ pathToFileWithoutExt}_worker${index}.json`) as CircuitData
			return inputCircuit.gates.map((x) => ({ a: x[0], b: x[1], target: x[2], gate_i: x[3] }))
		})
		const filename = `${ pathToFileWithoutExt }.solved-${ currentGates.length }.json`
		save(filename, currentGates, inputCircuit.wire_count, gates)
		const gatesRemoved = nPrevGates - currentGates.length
		logTimed(`Total Removed Gates Removed in total: ${ gatesRemoved }`)
		logTimed('')
		logTimed('')
	}
}
