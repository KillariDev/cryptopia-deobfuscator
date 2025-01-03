import * as fs from 'fs'
import sqlite3 from 'sqlite3'
import { findSwappableLines, shuffleLinesWithinGroups } from './lineswapper.js'
import { areBooleanArraysEqual, calculateAllOutputsArray, convertToOriginal, gatesToText, generateCombinations, getControlFunc, getRandomNumberInRange, getVars, ioHash, mapCircuit, mapVariablesToIndexes, readJsonFile, replace, reverseMapCircuit, simplifyGateOperatorIfGatesMatch, verifyCircuit, writeDictionaryToFile } from './utils.js'
import { CircuitData, Gate } from './types.js'
import { createRainbowTable, getReplacerById } from './rainbowtable.js'
import { LimitedMap } from './limitedMap.js'

const BYTE_ALL_INPUTS = new Map<number, boolean[][]>([
	[5, generateCombinations(5)],
	[6, generateCombinations(6)],
	[7, generateCombinations(7)],
	[8, generateCombinations(8)],
])
const findUselessVars = (sliceGates: Gate[], variableIndexMapping: number[], verbose: boolean) => {
	const nVariables = variableIndexMapping.length
	const allInputs = BYTE_ALL_INPUTS.get(nVariables)
	if (allInputs === undefined) return undefined
	const mappedGates = mapCircuit(sliceGates, variableIndexMapping)
	const expectedOutput = calculateAllOutputsArray(mappedGates, allInputs)
	for (let variableIndex = 0; variableIndex < nVariables; variableIndex++) {
		let replacevalue = 0
		while(true) {
			replacevalue = variableIndexMapping[getRandomNumberInRange(0, variableIndexMapping.length - 1)]
			if (replacevalue !== variableIndexMapping[variableIndex]) break
		}
		const newMapping = variableIndexMapping.map((value, i) => i === variableIndex ? replacevalue : value)
		const newCircuit = mapCircuit(reverseMapCircuit(mappedGates, newMapping), variableIndexMapping)
		if (areBooleanArraysEqual(expectedOutput, calculateAllOutputsArray(newCircuit, allInputs))) {
			if (verbose) console.log(`Replace variable v${ variableIndexMapping[variableIndex] } -> v${ replacevalue } (${ nVariables } -> ${ nVariables - 1 })`)
			return reverseMapCircuit(mappedGates, newMapping)
		}
	}
	return undefined
}

const RAINBOW_TABLE_WIRES = 4
const FOUR_BYTE_ALL_INPUTS = generateCombinations(RAINBOW_TABLE_WIRES)

const optimizeStep = async (db: sqlite3.Database, ioIdentifierCache: LimitedMap<string, Gate[] | null>, gates: Gate[], sliceSize: number, verbose: boolean): Promise<Gate[]> => {
	const replacements: { start: number, end: number, replacement: Gate[] }[] = []
	let uselessVarsFound = 0
	for (let a = 0; a < gates.length - sliceSize; a++) {
		const start = a
		const end = a + sliceSize
		const sliceGates = gates.slice(start, end)
		const variableIndexMapping = mapVariablesToIndexes(sliceGates) // map variables to smaller amount of wires
		if (sliceSize > 2) {
			const replacement = findUselessVars(sliceGates, variableIndexMapping, verbose)
			if (replacement !== undefined) {
				replacements.push({ start, end: end - 1, replacement: gateSimplifier(replacement, verbose) })
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
	if (replacements.length === 0) return gates
	const newCircuit = replace(gates, replacements)
	const diff = gates.length - newCircuit.length
	if (diff > 0 || uselessVarsFound > 0) {
		console.log(`Removed ${ diff } gates (${ gates.length } -> ${ newCircuit.length }) and simplified ${ uselessVarsFound } vars. With slice ${ sliceSize }`)
	}
	return newCircuit
}

const gateSimplifier = (gates: Gate[], verbose: boolean) => {
	return gates.map((gate) => {
		const newGateIndex = simplifyGateOperatorIfGatesMatch(gate)
		if (newGateIndex !== gate.gate_i) {
			if (verbose) console.log(`Simplified gate "${ getControlFunc(gate.gate_i) }" -> "${ getControlFunc(newGateIndex) }"`)
			return { ...gate, gate_i: newGateIndex }
		}
		return gate
	})
}

const optimize = async (db: sqlite3.Database, originalGates: Gate[], wires: number, problemName: string, verbose: boolean) => {
	const maxGates = originalGates.length
	let iterations = 0
	let optimizedVersion = originalGates.slice()
	let prevSavedLength = originalGates.length
	
	optimizedVersion = gateSimplifier(optimizedVersion, verbose)
	let sliceToUse = 2
	let lastSaved = performance.now()
	const ioIdentifierCache = new LimitedMap<string, Gate[] | null>(100000)
	while (true) {
		const currentGates = optimizedVersion.length
		optimizedVersion = await optimizeStep(db, ioIdentifierCache, optimizedVersion, sliceToUse, verbose)
		if (currentGates === optimizedVersion.length || iterations % 10 === 0) {
			// if we did not remove any gates, adjust slice to find bigger chunks
			sliceToUse++
			if (sliceToUse >= 10) sliceToUse = 2
		}
		if (prevSavedLength !== optimizedVersion.length) {
			const endTime = performance.now()
			const timeDiffMins = (endTime - lastSaved) / 60000
			if (timeDiffMins >= 10) {
				prevSavedLength = optimizedVersion.length
				const filename = `${ problemName }.solved-${ iterations }.json`
				optimizedVersion = gateSimplifier(optimizedVersion, verbose)
				console.log(`Saving a version with ${ optimizedVersion.length } gates to ${ filename } (${ Math.floor(optimizedVersion.length/originalGates.length*100) }% of original)`)
				console.log(`Average gate complexity: ${ optimizedVersion.flatMap((gate) => getVars(gate).length).reduce((a, c) => a + c, 0) / optimizedVersion.length }`)
				verifyCircuit(originalGates, optimizedVersion, wires, 20)
				fs.writeFileSync(filename, convertToOriginal(wires, optimizedVersion), 'utf8')
				lastSaved = endTime
			}
		}
		// shuffle every second time with small max group size to move group boundaries around
		const swapLines = iterations % 2 ? findSwappableLines(optimizedVersion, getRandomNumberInRange(2, 3)) : findSwappableLines(optimizedVersion, maxGates)
		optimizedVersion = shuffleLinesWithinGroups(optimizedVersion, swapLines)
		iterations++
	}
}

const run = async (pathToFileWithoutExt: string, verbose: boolean) => {
	const db = await createRainbowTable(RAINBOW_TABLE_WIRES)
	const inputCircuit = readJsonFile(`${ pathToFileWithoutExt }.json`) as CircuitData
	console.log('wire_count', inputCircuit.wire_count)
	console.log('gate_count', inputCircuit.gates.length)
	const gates: Gate[] = inputCircuit.gates.map((x) => ({ a: x[0], b: x[1], target: x[2], gate_i: x[3] }))
	writeDictionaryToFile({' gates': gatesToText(gates) }, `${ pathToFileWithoutExt }.commands.json`)
	writeDictionaryToFile(findSwappableLines(gates, gates.length), `${ pathToFileWithoutExt }.swappable.json`)
	
	try {
		await optimize(db, gates, inputCircuit.wire_count, pathToFileWithoutExt, verbose)
	} catch(e: unknown) {
		console.error(e)
	}
}

run('data/obfuscated', false)
