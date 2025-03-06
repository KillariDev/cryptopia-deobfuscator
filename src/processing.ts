import * as fs from 'fs'
import sqlite3 from 'sqlite3'
import { areBooleanArraysEqual, calculateAllOutputsArray, chunkArray, convertToOriginal, dependencyGraphToMap, dependencySort, evalCircuit, findConvexSubsets, generateCombinations, generateNRandomBooleanArray, getRandomNumberInRange, getVars, hashGates, hashGatesRange, ioHash, isReplacementSimpler, logTimed, mapCircuit, mapVariablesToIndexes, randomOrder, readJsonFile, remove, replace, reverseMapCircuit, simplifyGate, verifyCircuit } from './utils.js'
import { CircuitData, Gate } from './types.js'
import { getReplacersByIds } from './rainbowtable.js'
import { LimitedMap } from './limitedMap.js'
import { runWorker } from './threads.js'
import { createDependencyGraph } from './lineswapper.js'

const removeVariableFromGate = (gate: Gate, isA: boolean) => {
	const newGate = isA ? { ...gate, a: 0 } : { ...gate, b: 0 }
	switch(newGate.gate_i) {
		case 0: return newGate // false
		case 1: return isA ? { ...newGate, gate_i: 5 } : { ...newGate, gate_i: 3 }// a && b
		case 2: return isA ? {...newGate, gate_i: 10 } : {...newGate, gate_i: 3 } // a && !b
		case 3: return isA ? {...newGate, gate_i: 0 } : newGate // a
		case 4: return isA ? {...newGate, gate_i: 5 } : {...newGate, gate_i: 12 } // !a && b
		case 5: return isA ? newGate : {...newGate, gate_i: 0 } // b
		case 6: return isA ? {...newGate, gate_i: 5 } : {...newGate, gate_i: 3 }// xor(a,b)
		case 7: return isA ? {...newGate, gate_i: 5 } : {...newGate, gate_i: 3 }// a || b
		case 8: return isA ? {...newGate, gate_i: 10 } : {...newGate, gate_i: 12 } // !(a || b)
		case 9: return isA ? {...newGate, gate_i: 10 } : {...newGate, gate_i: 12 } // (a && b) || ((!a) && (!b)) (CNOT gate to NOT)
		case 10: return isA ? newGate : {...newGate, gate_i: 0 } // !b
		case 11: return isA ? {...newGate, gate_i: 10 } : {...newGate, gate_i: 3 } // (!b) || a
		case 12: return isA ? {...newGate, gate_i: 0 } : newGate // !a
		case 13: return isA ? {...newGate, gate_i: 5 } : {...newGate, gate_i: 12 } // (!a) || b
		case 14: return isA ? {...newGate, gate_i: 10 } : {...newGate, gate_i: 12 } // !(a && b)
		case 15: return newGate // return true
		default: throw new Error(`invalid control function: ${ gate.gate_i }`)
	}
}
function getCommonVariableIfTargetsMatch(gate1: Gate, gate2: Gate) {
	if (gate1.target !== gate2.target) return undefined
	const variables1 = getVars(gate1)
	if (gate1.gate_i === 15 && gate2.gate_i === 15) return variables1[0] // consider also truth gates
	const variables2 = getVars(gate2)
	if (variables1.length !== variables2.length) return undefined // consider only cases where vars match
	if (variables1[1] !== undefined && variables1[1] === variables2[1]) return variables1[1]
	if (variables1[1] !== undefined && variables1[1] === variables2[2]) return variables1[1]
	if (variables1[2] !== undefined && variables1[2] === variables2[1]) return variables2[1]
	if (variables1[2] !== undefined && variables1[2] === variables2[2]) return variables2[2]
	return undefined
}

function findMatchingOperations(gates: Gate[]): { gateIndex1: number, gateIndex2: number, matchingVariable: number }[] {
	const matchingPairs: { gateIndex1: number, gateIndex2: number, matchingVariable: number }[] = []
	// Loop through all pairs of gates
	for (let i = 0; i < gates.length; i++) {
		for (let j = i + 1; j < gates.length; j++) {
			const gate1 = gates[i]
			const gate2 = gates[j]
			// Find the common variable if targets match
			const commonVariable = getCommonVariableIfTargetsMatch(gate1, gate2)
			// If a common variable is found, store the pair
			if (commonVariable !== undefined) {
				matchingPairs.push({
					gateIndex1: i,
					gateIndex2: j,
					matchingVariable: commonVariable
				})
			}
		}
	}
	// Filter out matching pairs where either gate appears more than once or gates are identical
	return matchingPairs
}

export function combineGates(gates: Gate[]): { combined: boolean, gates: Gate[] } {
	const matches = findMatchingOperations(gates)
	if (matches.length === 0) return { combined: false, gates }
	let combined = false
	let newGates = gates
	for (const foundMatch of matches) {
		newGates = newGates.map((gate, index) => {
			if (gate !== undefined && (foundMatch.gateIndex1 === index || foundMatch.gateIndex2 === index)) {
				combined = true
				return removeVariable([gate], foundMatch.matchingVariable)[0]
			}
			return gate
		})
		break
	}
	return { combined, gates: newGates.filter((gate): gate is Gate => gate !== undefined) }
}

const removeVariable = (gates: Gate[], variable: number) => {
	return gates.map((gate) => {
		if (gate.target === variable) return undefined
		const vars = getVars(gate)
		if (vars.length === 2 && vars[1] === variable) return undefined
		if (gate.a === variable || gate.b === variable) {
			const simplified = simplifyGate(removeVariableFromGate(gate, gate.a === variable))
			if (simplified.gate_i === 0) return undefined // false gate that is identity gate, we can just remove it
			return simplified
		}
		return gate
	}).filter((gate): gate is Gate => gate !== undefined)
}

const removeNonTargetVariable = (gates: Gate[], variable: number) => {
	return gates.map((gate) => {
		const vars = getVars(gate)
		if (vars.length === 2 && vars[1] === variable) return undefined
		if (gate.a === variable || gate.b === variable) {
			const simplified = simplifyGate(removeVariableFromGate(gate, gate.a === variable))
			if (simplified.gate_i === 0) return undefined // false gate that is identity gate, we can just remove it
			return simplified
		}
		return gate
	}).filter((gate): gate is Gate => gate !== undefined)
}

export const areCircuitsProbabilisticallyTheSame = (cachedOutputs: boolean[][], oldCircuit: Gate[], newCircuit: Gate[], attempts: number, nVariables: number) => {
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
const replaceNonTargetVar = (gate: Gate, variableToReplace: number, variableToReplaceWith: number) => {
	return simplifyGate({
		a: gate.a === variableToReplace ? variableToReplaceWith : gate.a,
		b: gate.b === variableToReplace ? variableToReplaceWith : gate.b,
		target: gate.target,
		gate_i: gate.gate_i
	})
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
	
	const combined = combineGates(mappedGates)
	if (combined.combined) {
		if (areCircuitsProbabilisticallyTheSame(cachedOutputs, mappedGates, combined.gates, INPUTS, nVariables)) {
			return reverseMapCircuit(combined.gates, variableIndexMapping)
		}
	}
	
	for (let variableIndex = 0; variableIndex < nVariables; variableIndex++) {
		const newRemovedCircuit = removeVariable(mappedGates, variableIndex)
		if (areCircuitsProbabilisticallyTheSame(cachedOutputs, mappedGates, newRemovedCircuit, INPUTS, nVariables)) {
			return reverseMapCircuit(newRemovedCircuit, variableIndexMapping)
		}
		const hasVariableIndexAsNontarget = mappedGates.find((x) => {
			const vars = getVars(x)
			return vars[1] === variableIndex || vars[1] === variableIndex
		}) !== undefined
		if (hasVariableIndexAsNontarget) {
			const newRemovedCircuitNontarget = removeNonTargetVariable(mappedGates, variableIndex)
			if (areCircuitsProbabilisticallyTheSame(cachedOutputs, mappedGates, newRemovedCircuitNontarget, INPUTS, nVariables)) {
				return reverseMapCircuit(newRemovedCircuitNontarget, variableIndexMapping)
			}
		}
		for (let newVar = 0; newVar < nVariables; newVar++) {
			if (variableIndexMapping[variableIndex] <= variableIndexMapping[newVar]) continue
			const newCircuit = mappedGates.map((gate) => replaceVar(gate, variableIndex, newVar))
			if (areCircuitsProbabilisticallyTheSame(cachedOutputs, mappedGates, newCircuit, INPUTS, nVariables)) {
				return reverseMapCircuit(newCircuit, variableIndexMapping)
			}
			
			if (hasVariableIndexAsNontarget) {
				const newCircuit2 = mappedGates.map((gate) => replaceNonTargetVar(gate, variableIndex, newVar))
				if (areCircuitsProbabilisticallyTheSame(cachedOutputs, mappedGates, newCircuit2, INPUTS, nVariables)) {
					return reverseMapCircuit(newCircuit2, variableIndexMapping)
				}
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
		const variableRemovedGates = removeVariable(mappedGates, variableIndex)
		if (areBooleanArraysEqual(expectedOutput, calculateAllOutputsArray(variableRemovedGates, allInputs))) {
			return reverseMapCircuit(variableRemovedGates, variableIndexMapping)
		}
		const hasVariableIndexAsNontarget = mappedGates.find((x) => {
			const vars = getVars(x)
			return vars[1] === variableIndex || vars[1] === variableIndex
		}) !== undefined
		if (hasVariableIndexAsNontarget) {
			const newRemovedCircuitNontarget = removeNonTargetVariable(mappedGates, variableIndex)
			if (areBooleanArraysEqual(expectedOutput, calculateAllOutputsArray(variableRemovedGates, allInputs))) {
				return reverseMapCircuit(newRemovedCircuitNontarget, variableIndexMapping)
			}
		}
		for (const newVar of newVars) {
			if (variableIndexMapping[variableIndex] <= variableIndexMapping[newVar]) continue
			const newCircuit = mappedGates.map((gate) => replaceVar(gate, variableIndex, newVar))
			if (areBooleanArraysEqual(expectedOutput, calculateAllOutputsArray(newCircuit, allInputs))) {
				return reverseMapCircuit(newCircuit, variableIndexMapping)
			}
			
			if (hasVariableIndexAsNontarget) {
				const newCircuit2 = mappedGates.map((gate) => replaceNonTargetVar(gate, variableIndex, newVar))
				if (areBooleanArraysEqual(expectedOutput, calculateAllOutputsArray(newCircuit2, allInputs))) {
					return reverseMapCircuit(newCircuit2, variableIndexMapping)
				}
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
		const gatesHash = hashGatesRange(gates, start, end)
		if (processedGatesCache.has(gatesHash)) continue
		const sliceGates = gates.slice(start, end)

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
	const queries: { gatesHash: string, ioIdentifier: string, start: number, end: number, variableIndexMapping: number[], mappedGates: Gate[] }[] = []
	const replacements: { start: number, end: number, replacement: Gate[] }[] = []
	for (let a = 0; a < gates.length - sliceSize; a++) {
		const start = a
		const end = a + sliceSize
		const gatesHash = hashGatesRange(gates, start, end)
		if (processedGatesCache.has(gatesHash)) continue
		const sliceGates = gates.slice(start, end)

		const variableIndexMapping = mapVariablesToIndexes(sliceGates) // map variables to smaller amount of wires
		if (variableIndexMapping.length <= rainbowTableWires) {
			const mappedGates = mapCircuit(sliceGates, variableIndexMapping)
			const allOutputs = calculateAllOutputsArray(mappedGates, RAINBOW_TABLE_ALL_INPUTS)
			const ioIdentifier = ioHash(allOutputs)
			queries.push({ gatesHash, ioIdentifier: ioIdentifier, start, end: end, variableIndexMapping, mappedGates })
		}
	}
	const rainbowMatches = await getReplacersByIds(db, ioIdentifierCache, queries.map((x) => x.ioIdentifier))
	const rainbowMap = new Map<String, Gate[]>()
	rainbowMatches.forEach((entry) => { rainbowMap.set(entry.ioIdentifier, entry.gates) })
	let currentIndex = 0
	for (let query of queries) {
		const match = rainbowMap.get(query.ioIdentifier)
		if (match === undefined) {
			processedGatesCache.set(query.gatesHash, true)
			continue
		}
		const isSimpler = isReplacementSimpler(match, query.mappedGates)
		if (!isSimpler) {
			processedGatesCache.set(query.gatesHash, true)
			continue
		}
		if (query.start >= currentIndex) {
			currentIndex = query.end
			const replacement: Gate[] = reverseMapCircuit(match, query.variableIndexMapping)
			replacements.push({
				start: query.start,
				end: query.end - 1,
				replacement: replacement
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

function* allGatesWithTarget(target: number, wires: number) {
	for (let gate_i = 0; gate_i < 16; gate_i++) {
		switch (gate_i) {
			case 0: break //return false
			case 1: //return a && b
			case 2: //return a && !b
			case 4: //return !a && b
			case 6: //return xor(a, b)
			case 7: //return a || b
			case 8: //return !(a || b)
			case 9: //return (a && b) || (!a && !b)
			case 11: //return (!b) || a
			case 13: //return (!a) || b
			case 14: { //return !(a && b)
				for (let a = 0; a < wires; a++) {
					for (let b = a + 1; b < wires; b++) {
						if (a !== target && b !== target) yield { a, b, target, gate_i }
					}
				}
				break
			}
			case 10: //return !b
			case 5: { //return b
				for (let b = 0; b < wires; b++) {
					if (b !== target) yield { a: 0, b, target, gate_i }
				}
				break
			}
			case 12: //return !a
			case 3: { //return a
				for (let a = 0; a < wires; a++) {
					if (a !== target) yield { a, b: 0, target, gate_i }
				}
				break
			}
			case 15: { // return true
				yield { a: 0, b: 0, target, gate_i }
				break
			}
			default: throw new Error(`invalid control function: ${ gate_i }`)
		}
	}
}

const shuffleCache = new LimitedMap<string, Gate[]>(100000)
export function shuffleRowsWithDependentGateSwap(gates: Gate[], times: number) {
	const hasCommonNumber = (arr1: number, arr2: number[]): boolean => {
		return arr2.includes(arr1)
	}

	const swapDependingGates = (gates: Gate[], previous: number, current: number, previousDependsOnThis: boolean, thisDependsOnPrevious: boolean) => {
		const sliceGates = [gates[previous], gates[current]]
		const variableIndexMapping = mapVariablesToIndexes(sliceGates) // map variables to smaller amount of wires
		const nVariables = variableIndexMapping.length
		const allInputs = BYTE_ALL_INPUTS.get(nVariables)
		if (allInputs === undefined) return undefined
		const mappedGates = mapCircuit(sliceGates, variableIndexMapping)
		const gateKey = hashGates(mappedGates)
		const cache = shuffleCache.get(gateKey)
		if (cache) return reverseMapCircuit(cache, variableIndexMapping)
		const expectedOutput = calculateAllOutputsArray(mappedGates, allInputs)
		const swappedGates = [mappedGates[1], mappedGates[0]]
		const target1Gates = !thisDependsOnPrevious ? [swappedGates[0]] : Array.from(allGatesWithTarget(swappedGates[0].target, nVariables))
		const target2Gates = !previousDependsOnThis ? [swappedGates[1]] : Array.from(allGatesWithTarget(swappedGates[1].target, nVariables))
		const allSwappedPairs = target1Gates.flatMap((one) => target2Gates.map((two) => [one, two]))

		for (const pair of allSwappedPairs) {
			if (areBooleanArraysEqual(expectedOutput, calculateAllOutputsArray(pair, allInputs))) {
				const correctVars = gateSimplifier(reverseMapCircuit(pair, variableIndexMapping))
				shuffleCache.set(gateKey, correctVars)
				gates[previous] = correctVars[0]
				gates[current] = correctVars[1]
				return
			}
		}
		shuffleCache.set(gateKey, mappedGates)
	}
	console.log('shuffleRowsWithDependentGateSwap')
	for (let time = 0; time < times; time++) {
		for (let gateI = 1; gateI < gates.length; gateI++) {
			if (Math.random() < 0.5) continue
			const [thisAssigned, ...thisOthers] = getVars(gates[gateI])
			const [previousAssigned, ...previousOthers] = getVars(gates[gateI - 1])
			const previousDependsOnThis = hasCommonNumber(thisAssigned, [previousAssigned, ...previousOthers])
			const thisDependsOnPrevious = hasCommonNumber(previousAssigned, [thisAssigned, ...thisOthers])
			if (previousDependsOnThis || thisDependsOnPrevious) {
				swapDependingGates(gates, gateI - 1, gateI, previousDependsOnThis, thisDependsOnPrevious)
				continue
			}
			const prevGate = gates[gateI - 1]
			gates[gateI - 1] = gates[gateI]
			gates[gateI] = prevGate
		}
	}
}

function appendMissingNumbers(arr: number[], n: number): number[] {
	// Create a set for the numbers from 0 to n
	const allNumbers = new Set<number>()
	for (let i = 0; i < n; i++) {
		allNumbers.add(i);
	}

	// Remove numbers that already exist in the input array
	arr.forEach(num => allNumbers.delete(num))

	// Convert the set to an array and append it to the original array
	return [...Array.from(allNumbers), ...arr]
}

const optimizeSubset = async (db: sqlite3.Database, slicedVersion: Gate[], ioIdentifierCache: LimitedMap<string, Gate[] | null>, processedGatesCache: LimitedMap<string, boolean>, subsetSize: number, maxSlice: number, phase: 'simplest' | 'fast' | 'heavy', timeToEndWorker: () => boolean, rainbowTableWires: number, rainbowTableAllInputs: boolean[][]): Promise<Gate[]> => {
	const useProbabilistically = phase === 'heavy'
	const findUselessVarsSetting = true //phase === 'heavy'
	let regenerateGraph = false
	do {
		let graphIterator = findConvexSubsets(subsetSize, slicedVersion)
		regenerateGraph = false
		let linesLooped = 0
		for (let lines of graphIterator) {
			let sliceToUse = 1
			linesLooped++
			while(true) {
				const linesN = lines.length
				if (linesN === 0) break
				const inGates = lines.map((x) => slicedVersion[x])
				let it = 0
				let gotMatch = false
				for (;it < maxSlice; it++) {
					sliceToUse++
					if (sliceToUse > maxSlice) sliceToUse = 2
					if (sliceToUse > linesN) continue
					if (timeToEndWorker()) {
						console.log(`did not finish iteration loop: ${linesLooped}/${slicedVersion.length} sub${subsetSize} slice:${maxSlice}`)
						return slicedVersion
					}
					const slice = phase === 'heavy' && !gotMatch ? getRandomNumberInRange(6, subsetSize) : (sliceToUse <= 6 ? sliceToUse : getRandomNumberInRange(sliceToUse, subsetSize))
					const optimizationOutput = await massOptimizeStep(db, ioIdentifierCache, processedGatesCache, inGates, slice, useProbabilistically, findUselessVarsSetting, rainbowTableWires, rainbowTableAllInputs)
					if (optimizationOutput.changed) {
						const nodes = createDependencyGraph(optimizationOutput.gates)
						const dependantMap = dependencyGraphToMap(nodes)
						const newGates = appendMissingNumbers(dependencySort(dependantMap, nodes[nodes.length - 1], nodes.length, nodes, optimizationOutput.gates), nodes.length).map((x) => optimizationOutput.gates[x])
						slicedVersion = insertArrayAtIndex(slicedVersion, newGates, lines[lines.length - 1] + 1)
						slicedVersion = remove(slicedVersion, lines)
						const offset = lines[lines.length - 1] + 1 - lines.length
						lines = Array.from(Array(optimizationOutput.gates.length).keys()).map((x) => x + offset)
						regenerateGraph = true
						sliceToUse = 1
						it = 0
						gotMatch = true
						break
					}
				}
				if (it === maxSlice) break
			}
			if (regenerateGraph) {
				break
			}
		}
	} while(regenerateGraph)
	console.log(`completed iteration loop: ${slicedVersion.length} sub${subsetSize} slice:${maxSlice}`)
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
	let subsetSize = 300
	let maxSlice = 10
	let phase: 'simplest' | 'fast' | 'heavy' = 'fast'
	logTimed(`optimizer started with subset ${subsetSize}`)
	const timeToEndWorker = () => {
		const endTime = performance.now()
		const timeDiffMins = (endTime - lastSaved) / 60000
		return timeDiffMins >= 5
	}
	while (true) {
		shuffleRows(optimizedVersion, 20)
		const sliceStart = 0
		const sliceEnd = optimizedVersion.length
		let slicedVersion = optimizedVersion.slice(sliceStart, sliceEnd)
		const nChunks = Math.max(1, Math.min(5, Math.floor(slicedVersion.length / 4000)))
		const chunked = chunkArray(slicedVersion, nChunks)
		slicedVersion = (await Promise.all(chunked.flatMap(async (data) => optimizeSubset(db, data, ioIdentifierCache, processedGatesCache, subsetSize, maxSlice, phase, timeToEndWorker, rainbowTableWires, rainbowTableAllInputs)))).flat()
		optimizedVersion = [...optimizedVersion.slice(0, sliceStart), ...slicedVersion, ...optimizedVersion.slice(sliceEnd, optimizedVersion.length)]
		subsetSize = 40
		phase = 'heavy'
		
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

export const splitTaskAndRun = async (pathToFileWithoutExt: string, original: string) => {
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

	const originlCircuit = readJsonFile(`${ original }.json`) as CircuitData
	const originalGates: Gate[] = originlCircuit.gates.map((x) => ({ a: x[0], b: x[1], target: x[2], gate_i: x[3] }))
	const inputCircuit = readJsonFile(`${ pathToFileWithoutExt }.json`) as CircuitData
	const gates: Gate[] = inputCircuit.gates.map((x) => ({ a: x[0], b: x[1], target: x[2], gate_i: x[3] }))

	if (originalGates.length < gates.length) throw new Error('Original circuit is bigger than working. Do you have arguments the right way?')
	verifyCircuit(originalGates, gates, originlCircuit.wire_count, 20)
	const nMaxWorkers = 12
	let currentGates = gates.slice()
	while(true) {
		currentGates = gateSimplifier(currentGates)
		let lastIterationTime = performance.now()
		const nPrevGates = currentGates.length
		const nWorkers = Math.min(currentGates.length / 4000, nMaxWorkers)
		const approxGates = splitArrayIntoApproximatelyChunks(currentGates, nWorkers)
		await Promise.all(approxGates.map(async (dataChunk, index) => {
			const workerFile = `${ pathToFileWithoutExt}_worker${index}.json`
			fs.writeFileSync(workerFile, convertToOriginal(inputCircuit.wire_count, dataChunk), 'utf8')
			await runWorker(workerFile)
		}))
		console.log('main thread')
		currentGates = approxGates.flatMap((_, index) => {
			const inputCircuit = readJsonFile(`${ pathToFileWithoutExt}_worker${index}.json`) as CircuitData
			return inputCircuit.gates.map((x) => ({ a: x[0], b: x[1], target: x[2], gate_i: x[3] }))
		})
		const filename = `${ pathToFileWithoutExt }.solved-${ currentGates.length }.json`
		save(filename, currentGates, inputCircuit.wire_count, originalGates)
		save('data/latest.json', currentGates, inputCircuit.wire_count, originalGates)
		const gatesRemoved = nPrevGates - currentGates.length
		const endTime = performance.now()
		const timeDiffMins = (endTime - lastIterationTime) / 60000
		logTimed('')
		logTimed('')
		logTimed(`Total gates removed in iteration: ${ gatesRemoved } (${ Math.floor(gatesRemoved/timeDiffMins * 60) } gates/hour)`)
		logTimed('')
		logTimed('')
		shuffleRowsWithDependentGateSwap(currentGates, 1)
		shuffleRows(currentGates, 20)
	}
}
