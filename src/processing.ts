import { templates, advancedRewrite } from './strategies.js'
import { IncrementalEvaluator } from './packed.js'
import { RewriteCache, SearchScheduler, balancedChunks, improving, SearchArm } from './search.js'
import { config } from './config.js'
import sqlite3 from 'sqlite3'
import { formatProgress, formatWorkerActivity, formatStatus, WorkerActivity, WorkerStatus, shouldFinishReducedRound, logVerbose } from './logging.js'
import { areBooleanArraysEqual, calculateAllOutputsArray, chunkArray, dependencyGraphToMap, dependencySort, evalCircuit, findConvexSubsets, generateCombinations, generateNRandomBooleanArray, getRandomNumberInRange, getVars, hashGates, hashGatesRange, ioHash, isReplacementSimpler, logTimed, mapCircuit, mapVariablesToIndexes, randomOrder, remove, replace, reverseMapCircuit, simplifyGate, verifyCircuit } from './utils.js'
import { Gate } from './types.js'
import { getReplacersByIds } from './rainbowtable.js'
import { LimitedMap } from './limitedMap.js'
import { WorkerPool, configuredWorkerCount } from './threads.js'
import { createDependencyGraph } from './lineswapper.js'
import { outputPaths, prepareOutputDirectories, writeCircuit, writeCircuitCopies, ReductionCheckpoint } from './storage.js'
import { JobCircuits, loadJob, WORKER_ROUND_MS } from './job.js'

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

export function findMatchingOperation(gates: Gate[]): { gateIndex1: number, gateIndex2: number, matchingVariable: number } | undefined {
	for (let i = 0; i < gates.length; i++) {
		for (let j = i + 1; j < gates.length; j++) {
			const commonVariable = getCommonVariableIfTargetsMatch(gates[i], gates[j])
			if (commonVariable !== undefined) return { gateIndex1: i, gateIndex2: j, matchingVariable: commonVariable }
		}
	}
}

export function combineGates(gates: Gate[]): { combined: boolean, gates: Gate[] } {
	const match = findMatchingOperation(gates)
	if (!match) return { combined: false, gates }
	const newGates = gates.map((gate, index) => {
		if (index === match.gateIndex1 || index === match.gateIndex2) return removeVariable([gate], match.matchingVariable)[0]
		return gate
	})
	return { combined: true, gates: newGates.filter((gate): gate is Gate => gate !== undefined) }
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
	if (attempts < 0 || attempts > INPUTS || !Number.isInteger(attempts)) throw new Error('Invalid attempt count')
	if (attempts === 0) return true
	let inputs = randomInputSets.get(nVariables)
	if (!inputs) {
		inputs = randomInputs.map(input => input.slice(0, nVariables))
		randomInputSets.set(nVariables, inputs)
	}
	// Reject most bad candidates with one scalar evaluation before batching.
	if (cachedOutputs[0] === undefined) cachedOutputs[0] = evalCircuit(oldCircuit, inputs[0])
	if (!areBooleanArraysEqual(cachedOutputs[0], evalCircuit(newCircuit, inputs[0]))) return false
	if (attempts === 1) return true
	const signature = hashGates(oldCircuit)
	let context = packedReferences.get(cachedOutputs)
	if (!context || context.signature !== signature || context.attempts !== attempts || context.wires !== nVariables) {
		const evaluator = new IncrementalEvaluator(oldCircuit, inputs.slice(1, attempts), config.search.incrementalEvaluation ? config.search.prefixCacheBytes : 0, config.search.prefixStride)
		context = { evaluator, signature, attempts, wires: nVariables }
		packedReferences.set(cachedOutputs, context)
		evaluator.unpack().forEach((output, i) => { cachedOutputs[i + 1] = output })
	}
	return context.evaluator.equivalent(newCircuit)
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

const MAX_DETERMINISTIC_USELESS_VARS = config.search.exactMaximumWires + 1
const BYTE_ALL_INPUTS = new Map<number, boolean[][]>()
for (let wires = 2; wires < MAX_DETERMINISTIC_USELESS_VARS; wires++) {
	BYTE_ALL_INPUTS.set(wires, generateCombinations(wires))
}

const INPUTS = config.validation.probabilisticInputs
const randomInputs = generateNRandomBooleanArray(INPUTS, config.validation.maximumWires)
const randomInputSets = new Map<number, boolean[][]>()
const packedReferences = new WeakMap<boolean[][], { evaluator: IncrementalEvaluator, signature: string, attempts: number, wires: number }>()
const normalizedRewrites = new RewriteCache(config.search.normalizedCacheEntries)
const findProbabilisticUselessVars = (variableIndexMapping: number[], mappedGates: Gate[]) => {
	const nVariables = variableIndexMapping.length
	const cachedOutputs: boolean[][] = []
	const canImprove = improving(mappedGates)
	if (nVariables < MAX_DETERMINISTIC_USELESS_VARS) return undefined // no need to do this approach for less than 8 vars as we have exact way already
	if (areCircuitsProbabilisticallyTheSame(cachedOutputs, mappedGates, [], INPUTS, nVariables)) return []
	
	const combined = combineGates(mappedGates)
	if (combined.combined) {
		if (canImprove(combined.gates) && areCircuitsProbabilisticallyTheSame(cachedOutputs, mappedGates, combined.gates, INPUTS, nVariables)) {
			return reverseMapCircuit(combined.gates, variableIndexMapping)
		}
	}
	
	for (let variableIndex = 0; variableIndex < nVariables; variableIndex++) {
		const newRemovedCircuit = removeVariable(mappedGates, variableIndex)
		if (canImprove(newRemovedCircuit) && areCircuitsProbabilisticallyTheSame(cachedOutputs, mappedGates, newRemovedCircuit, INPUTS, nVariables)) {
			return reverseMapCircuit(newRemovedCircuit, variableIndexMapping)
		}
		const hasVariableIndexAsNontarget = mappedGates.find((x) => {
			const vars = getVars(x)
			return vars.slice(1).includes(variableIndex)
		}) !== undefined
		if (hasVariableIndexAsNontarget) {
			const newRemovedCircuitNontarget = removeNonTargetVariable(mappedGates, variableIndex)
			if (canImprove(newRemovedCircuitNontarget) && areCircuitsProbabilisticallyTheSame(cachedOutputs, mappedGates, newRemovedCircuitNontarget, INPUTS, nVariables)) {
				return reverseMapCircuit(newRemovedCircuitNontarget, variableIndexMapping)
			}
		}
		for (let newVar = 0; newVar < nVariables; newVar++) {
			if (variableIndexMapping[variableIndex] <= variableIndexMapping[newVar]) continue
			const newCircuit = mappedGates.map((gate) => replaceVar(gate, variableIndex, newVar))
			if (canImprove(newCircuit) && areCircuitsProbabilisticallyTheSame(cachedOutputs, mappedGates, newCircuit, INPUTS, nVariables)) {
				return reverseMapCircuit(newCircuit, variableIndexMapping)
			}
			
			if (hasVariableIndexAsNontarget) {
				const newCircuit2 = mappedGates.map((gate) => replaceNonTargetVar(gate, variableIndex, newVar))
				if (canImprove(newCircuit2) && areCircuitsProbabilisticallyTheSame(cachedOutputs, mappedGates, newCircuit2, INPUTS, nVariables)) {
					return reverseMapCircuit(newCircuit2, variableIndexMapping)
				}
			}
		}
	}
	return undefined
}

const findExactReplacement = (variableIndexMapping: number[], mappedGates: Gate[]) => {
	const nVariables = variableIndexMapping.length
	const allInputs = BYTE_ALL_INPUTS.get(nVariables)
	if (allInputs === undefined) return undefined
	const newVars = randomOrder(nVariables)
	const canImprove = improving(mappedGates)
	const expectedOutput = calculateAllOutputsArray(mappedGates, allInputs)
	if (areBooleanArraysEqual(expectedOutput, allInputs.flat())) return []
	for (let variableIndex = 0; variableIndex < nVariables; variableIndex++) {
		const variableRemovedGates = removeVariable(mappedGates, variableIndex)
		if (canImprove(variableRemovedGates) && areBooleanArraysEqual(expectedOutput, calculateAllOutputsArray(variableRemovedGates, allInputs))) {
			return reverseMapCircuit(variableRemovedGates, variableIndexMapping)
		}
		const hasVariableIndexAsNontarget = mappedGates.find((x) => {
			const vars = getVars(x)
			return vars.slice(1).includes(variableIndex)
		}) !== undefined
		if (hasVariableIndexAsNontarget) {
			const newRemovedCircuitNontarget = removeNonTargetVariable(mappedGates, variableIndex)
			if (canImprove(newRemovedCircuitNontarget) && areBooleanArraysEqual(expectedOutput, calculateAllOutputsArray(newRemovedCircuitNontarget, allInputs))) {
				return reverseMapCircuit(newRemovedCircuitNontarget, variableIndexMapping)
			}
		}
		for (const newVar of newVars) {
			if (variableIndexMapping[variableIndex] <= variableIndexMapping[newVar]) continue
			const newCircuit = mappedGates.map((gate) => replaceVar(gate, variableIndex, newVar))
			if (canImprove(newCircuit) && areBooleanArraysEqual(expectedOutput, calculateAllOutputsArray(newCircuit, allInputs))) {
				return reverseMapCircuit(newCircuit, variableIndexMapping)
			}
			
			if (hasVariableIndexAsNontarget) {
				const newCircuit2 = mappedGates.map((gate) => replaceNonTargetVar(gate, variableIndex, newVar))
				if (canImprove(newCircuit2) && areBooleanArraysEqual(expectedOutput, calculateAllOutputsArray(newCircuit2, allInputs))) {
					return reverseMapCircuit(newCircuit2, variableIndexMapping)
				}
			}
		}
		
	}
	return undefined
}

const findUselessVars = (mapping: number[], gates: Gate[]) => {
	if (mapping.length > config.search.exactMaximumWires) return undefined
	const result = normalizedRewrites.resolve(gates, canonical => findExactReplacement(Array.from({ length: mapping.length }, (_, i) => i), canonical))
	if (result !== undefined && config.synthesis.templates) templates.learn(gates, result)
	return result === undefined ? undefined : reverseMapCircuit(result, mapping)
}

const insertArrayAtIndex = (originalArray: Gate[], newArray: Gate[], index: number): Gate[] => {
	if (index < 0 || index > originalArray.length) throw new Error('Index out of bounds')
	const before = originalArray.slice(0, index)
	const after = originalArray.slice(index)
	return [...before, ...newArray, ...after]
}

type PreparedWindow = { variableIndexMapping: number[], mappedGates: Gate[] }

const optimizeVariables = (processedGatesCache: LimitedMap<string, boolean>, gates: Gate[], sliceSize: number, useProbabilistically: boolean, findUselessVarsSetting: boolean, rainbowTableWires: number, prepared: Map<number, PreparedWindow>): { gates: Gate[], changed: boolean } => {
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
		const mappedGates = mapCircuit(sliceGates, variableIndexMapping)
		prepared.set(start, { variableIndexMapping, mappedGates })
		const replacement = findUselessVars(variableIndexMapping, mappedGates)
		if (replacement !== undefined) {
			replacements.push({ start, end: end - 1, replacement: gateSimplifier(replacement) })
			uselessVarsFound++
			a += sliceSize - 1 // increment by slice amount that we don't optimize the same part again
			continue
		}
		if (useProbabilistically) {
			const replacement = findProbabilisticUselessVars(variableIndexMapping, mappedGates)
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
	logVerbose(`VAR: Removed ${ diff } gates, exact simplified ${ uselessVarsFound } vars, probabilistically simplified ${ uselessVarsFoundProb } vars. With slice ${ sliceSize }`)
	return { gates: newCircuit, changed: true }
}

export const massOptimizeStep = async (db: sqlite3.Database, ioIdentifierCache: LimitedMap<string, Gate[] | null>, processedGatesCache: LimitedMap<string, boolean>, originalGates: Gate[], sliceSize: number, useProbabilistically: boolean, findUselessVarsSetting: boolean, rainbowTableWires: number, RAINBOW_TABLE_ALL_INPUTS: boolean[][], lookup = true): Promise<{ gates: Gate[], changed: boolean }> => {
	const prepared = new Map<number, PreparedWindow>()
	const templateResult = config.synthesis.templates ? templates.rewrite(originalGates) : originalGates
	const changes = optimizeVariables(processedGatesCache, templateResult, sliceSize, useProbabilistically, findUselessVarsSetting, lookup ? rainbowTableWires : 0, prepared)
	changes.changed ||= templateResult !== originalGates
	if (!lookup) {
		if (!changes.changed) { const candidate = await advancedRewrite(originalGates); if (candidate) return { gates: candidate, changed: true } }
		return changes
	}
	const gates = changes.gates
	const queries: { gatesHash: string, ioIdentifier: string, start: number, end: number, variableIndexMapping: number[], mappedGates: Gate[] }[] = []
	const replacements: { start: number, end: number, replacement: Gate[] }[] = []
	for (let a = 0; a < gates.length - sliceSize; a++) {
		const start = a
		const end = a + sliceSize
		const gatesHash = hashGatesRange(gates, start, end)
		if (processedGatesCache.has(gatesHash)) continue
		// Window positions remain valid only when the variable pass made no changes.
		const cached = changes.changed ? undefined : prepared.get(start)
		const sliceGates = cached ? [] : gates.slice(start, end)
		const variableIndexMapping = cached?.variableIndexMapping ?? mapVariablesToIndexes(sliceGates)
		if (variableIndexMapping.length <= rainbowTableWires) {
			const mappedGates = cached?.mappedGates ?? mapCircuit(sliceGates, variableIndexMapping)
			const allOutputs = calculateAllOutputsArray(mappedGates, RAINBOW_TABLE_ALL_INPUTS)
			const ioIdentifier = ioHash(allOutputs)
			queries.push({ gatesHash, ioIdentifier, start, end, variableIndexMapping, mappedGates })
		}
	}
	const rainbowMatches = await getReplacersByIds(db, ioIdentifierCache, queries.map((x) => x.ioIdentifier))
	const rainbowMap = new Map<String, Gate[]>()
	rainbowMatches.forEach((entry) => { rainbowMap.set(entry.ioIdentifier, entry.gates) })
	let currentIndex = 0
	for (const query of queries) {
		const match = rainbowMap.get(query.ioIdentifier)
		if (!match || match.flatMap(getVars).some(wire => wire >= query.variableIndexMapping.length) || !isReplacementSimpler(match, query.mappedGates)) {
			processedGatesCache.set(query.gatesHash, true)
			continue
		}
		if (query.start < currentIndex) continue
		currentIndex = query.end
		replacements.push({ start: query.start, end: query.end - 1, replacement: reverseMapCircuit(match, query.variableIndexMapping) })
	}
	if (replacements.length === 0) {
		if (!changes.changed) { const candidate = await advancedRewrite(originalGates); if (candidate) return { gates: candidate, changed: true } }
		return changes
	}
	const newCircuit = replace(gates, replacements)
	const diff = gates.length - newCircuit.length
	if (diff > 0) logVerbose(`Rainbow: Removed ${ diff } gates with slice ${ sliceSize }`)
	return { gates: newCircuit, changed: true }
}

const gateSimplifier = (gates: Gate[]) => gates.map((gate) => simplifyGate(gate))

const save = (filenames: string[], gates: Gate[], wires: number, originalGates: Gate[]) => {
	gates = gateSimplifier(gates)
	logTimed(`Saving a version with ${ gates.length } gates to ${ filenames.join(', ') } (${ Math.floor(gates.length/originalGates.length*100) }% of original)`)
	logVerbose(`Average gate complexity: ${ gates.flatMap((gate) => getVars(gate).length).reduce((a, c) => a + c, 0) / gates.length }`)
	verifyCircuit(originalGates, gates, wires, config.validation.checkpointInputs)
	writeCircuitCopies(filenames, wires, gates)
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

const shuffleCache = new LimitedMap<string, Gate[]>(config.cache.shuffleEntries)
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
		if (cache) {
			const restored = reverseMapCircuit(cache, variableIndexMapping)
			gates[previous] = restored[0]
			gates[current] = restored[1]
			return
		}
		const expectedOutput = calculateAllOutputsArray(mappedGates, allInputs)
		const swappedGates = [mappedGates[1], mappedGates[0]]
		const target1Gates = !thisDependsOnPrevious ? [swappedGates[0]] : Array.from(allGatesWithTarget(swappedGates[0].target, nVariables))
		const target2Gates = !previousDependsOnThis ? [swappedGates[1]] : Array.from(allGatesWithTarget(swappedGates[1].target, nVariables))
		for (const one of target1Gates) for (const two of target2Gates) {
			const pair = [one, two]
			if (areBooleanArraysEqual(expectedOutput, calculateAllOutputsArray(pair, allInputs))) {
				const correctVars = gateSimplifier(reverseMapCircuit(pair, variableIndexMapping))
				shuffleCache.set(gateKey, pair)
				gates[previous] = correctVars[0]
				gates[current] = correctVars[1]
				return
			}
		}
		shuffleCache.set(gateKey, mappedGates)
	}
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

export const optimizeSubset = async (db: sqlite3.Database, slicedVersion: Gate[], ioIdentifierCache: LimitedMap<string, Gate[] | null>, processedGatesCache: LimitedMap<string, boolean>, subsetSize: number, maxSlice: number, phase: 'simplest' | 'heavy', timeToEndWorker: () => boolean, rainbowTableWires: number, rainbowTableAllInputs: boolean[][], activity: WorkerActivity, onCandidate: (gates: Gate[]) => void, testedSubsets: LimitedMap<string, boolean>, method: SearchArm['method']): Promise<Gate[]> => {
	const useProbabilistically = method !== 'rainbow' && phase === 'heavy' && config.search.probabilistic
	const findUselessVarsSetting = method !== 'rainbow' && config.search.variableElimination
	let regenerateGraph = false
	let linesLooped = 0
	let changedWires = new Set<number>()
	do {
		let graphIterator = findConvexSubsets(subsetSize, slicedVersion, config.search.prioritizeChangedWires ? changedWires : undefined)
		regenerateGraph = false
		for (let lines of graphIterator) {
			const subsetKey = `${maxSlice}:${method}:${hashGates(lines.map(line => slicedVersion[line]))}`
			if (testedSubsets.has(subsetKey)) continue
			let subsetChanged = false
			let sliceToUse = config.search.sliceMinimum - 1
			linesLooped++
			activity.subsets++
			while(true) {
				const linesN = lines.length
				if (linesN === 0) break
				const inGates = lines.map((x) => slicedVersion[x])
				let it = 0
				for (;it < maxSlice; it++) {
					sliceToUse++
					if (sliceToUse > maxSlice) sliceToUse = config.search.sliceMinimum
					if (sliceToUse > linesN) continue
					if (timeToEndWorker()) {
						logVerbose(`did not finish iteration loop: ${linesLooped}/${slicedVersion.length} sub${subsetSize} slice:${maxSlice}`)
						return slicedVersion
					}
					const slice = sliceToUse
					activity.checks++
					const optimizationOutput = await massOptimizeStep(db, ioIdentifierCache, processedGatesCache, inGates, slice, useProbabilistically, findUselessVarsSetting, rainbowTableWires, rainbowTableAllInputs, method !== 'variables')
					if (optimizationOutput.changed) {
						subsetChanged = true
						activity.improvements++
						changedWires = new Set([...inGates, ...optimizationOutput.gates].flatMap(getVars))
						const nodes = createDependencyGraph(optimizationOutput.gates)
						const dependantMap = dependencyGraphToMap(nodes)
						const newGates = (nodes.length === 0 ? [] : appendMissingNumbers(dependencySort(dependantMap, nodes[nodes.length - 1], nodes.length, nodes, optimizationOutput.gates), nodes.length)).map((x) => optimizationOutput.gates[x])
						slicedVersion = insertArrayAtIndex(slicedVersion, newGates, lines[lines.length - 1] + 1)
						slicedVersion = remove(slicedVersion, lines)
						onCandidate(slicedVersion)
						const offset = lines[lines.length - 1] + 1 - lines.length
						lines = Array.from(Array(optimizationOutput.gates.length).keys()).map((x) => x + offset)
						regenerateGraph = true
						sliceToUse = config.search.sliceMinimum - 1
						it = 0
						break
					}
				}
				if (it === maxSlice) break
			}
			if (!subsetChanged) testedSubsets.set(subsetKey, true)
			if (regenerateGraph) {
				break
			}
		}
	} while(regenerateGraph)
	//console.log(`completed iteration loop: ${slicedVersion.length} sub${subsetSize} slice:${maxSlice}. Loops: ${linesLooped}`)
	return slicedVersion
}

export const createOptimizerCaches = () => ({
	ioIdentifierCache: new LimitedMap<string, Gate[] | null>(config.cache.lookupEntries),
	processedGatesCache: new LimitedMap<string, boolean>(config.cache.processedEntries),
	scheduler: new SearchScheduler(config.search.explorationEvery),
	testedSubsets: new LimitedMap<string, boolean>(config.cache.subsetEntries),
	methodCaches: new Map<string, LimitedMap<string, boolean>>(),
})

export const optimize = async (db: sqlite3.Database, originalGates: Gate[], wires: number, problemName: string, workerMode: boolean, rainbowTableWires: number, caches = createOptimizerCaches(), roundDurationMs = WORKER_ROUND_MS, onProgress?: (gates: number, activity: WorkerActivity, snapshot: Gate[]) => void, shouldFinish?: () => boolean) => {
	let optimizedVersion = originalGates.slice()
	let prevSavedLength = originalGates.length
	optimizedVersion = gateSimplifier(optimizedVersion)
	verifyCircuit(originalGates, optimizedVersion, wires, config.validation.checkpointInputs)
	let lastSaved = performance.now()
	const { ioIdentifierCache, processedGatesCache } = caches
	
	const rainbowTableAllInputs = generateCombinations(rainbowTableWires)
	let subsetSize = getRandomNumberInRange(config.search.subsetMinimum, config.search.subsetMaximum + 1)
	let maxSlice = getRandomNumberInRange(config.search.sliceMinimum, config.search.sliceMaximum + 1)
	let phase: 'simplest' | 'heavy' = 'heavy'
	const arms: SearchArm[] = Array.from({ length: config.search.searchArms }, (_, index) => ({ method: (['all', 'variables', 'rainbow'] as const)[index % 3], subset: getRandomNumberInRange(config.search.subsetMinimum, config.search.subsetMaximum + 1), slice: getRandomNumberInRange(config.search.sliceMinimum, config.search.sliceMaximum + 1) }))
	//logTimed(`optimizer started with subset ${subsetSize}`)
	const activity: WorkerActivity = { passes: 0, subsets: 0, checks: 0, improvements: 0, stage: 'searching' }
	let lastProgress = performance.now()
	let candidateSnapshot = optimizedVersion
	onProgress?.(optimizedVersion.length, { ...activity }, candidateSnapshot)
	const timeToEndWorker = () => {
		const endTime = performance.now()
		if (onProgress && endTime - lastProgress >= config.timing.workerReportSeconds * 1000) {
			onProgress(candidateSnapshot.length, { ...activity }, candidateSnapshot)
			lastProgress = endTime
		}
		return shouldFinish?.() === true || endTime - lastSaved >= roundDurationMs
	}
	while (true) {
		if (workerMode && optimizedVersion.length === 0) return optimizedVersion
		//shuffleRows(optimizedVersion, 20)
		let method: SearchArm['method'] = 'all'
		if (config.search.adaptive) {
			const selected = caches.scheduler.choose(arms)
			subsetSize = selected.subset
			maxSlice = selected.slice
			method = selected.method
		}
		const selection = { subset: subsetSize, slice: maxSlice, method }
		let methodCache = caches.methodCaches.get(method ?? 'all')
		if (!methodCache) {
			methodCache = method === 'all' ? processedGatesCache : new LimitedMap<string, boolean>(config.cache.processedEntries)
			caches.methodCaches.set(method ?? 'all', methodCache)
		}
		logVerbose(`Search: ${method}, subset ${subsetSize}, slice ${maxSlice}`)
		const searchStarted = performance.now()
		activity.passes++
		activity.stage = 'searching'
		const startLength = optimizedVersion.length
		const nChunks = Math.max(1, Math.min(config.search.maximumInnerChunks, Math.floor(optimizedVersion.length / config.search.minimumInnerChunkGates)))
		const chunked = chunkArray(optimizedVersion, nChunks)
		const chunkVersions = chunked.slice()
		optimizedVersion = (await Promise.all(chunked.map(async (data, index) => {
			const result = await optimizeSubset(db, data, ioIdentifierCache, methodCache!, subsetSize, maxSlice, phase, timeToEndWorker, rainbowTableWires, rainbowTableAllInputs, activity, gates => {
				chunkVersions[index] = gates
				candidateSnapshot = chunkVersions.flat()
				timeToEndWorker()
			}, caches.testedSubsets, method)
			chunkVersions[index] = result
			candidateSnapshot = chunkVersions.flat()
			return result
		}))).flat()
		candidateSnapshot = optimizedVersion
		caches.scheduler.record(selection, performance.now() - searchStarted, startLength - optimizedVersion.length)
		/*if (phase === 'heavy' && config.search.probabilistic) {
			shuffleRowsWithDependentGateSwap(optimizedVersion, 1)
			maxSlice++
			if (maxSlice > subsetSize) subsetSize++
			if (maxSlice > optimizedVersion.length) return
		}*/
		//else if (optimizedVersion.length < startLength) {
			activity.stage = 'shuffling'
			if (!timeToEndWorker()) shuffleRowsWithDependentGateSwap(optimizedVersion, config.search.workerShufflePasses)
			subsetSize = getRandomNumberInRange(config.search.subsetMinimum, config.search.subsetMaximum + 1)
			maxSlice = getRandomNumberInRange(config.search.sliceMinimum, config.search.sliceMaximum + 1)
		/*} else {
			phase = 'heavy'
			subsetSize = 40
			maxSlice = 11
		}*/
		
		const gatesRemoved = prevSavedLength - optimizedVersion.length
		if (workerMode) {
			if (timeToEndWorker()) {
				logVerbose(`Total Removed Gates Since Terminating: ${ gatesRemoved }`)
				activity.stage = 'verifying'
				onProgress?.(optimizedVersion.length, { ...activity }, optimizedVersion)
				verifyCircuit(originalGates, optimizedVersion, wires, config.validation.checkpointInputs)
				return optimizedVersion
			}
		} else {
			if (gatesRemoved > 0) {
				const endTime = performance.now()
				const timeDiffMins = (endTime - lastSaved) / 60000
				if (timeDiffMins >= config.timing.standaloneSaveSeconds / 60) {
					logVerbose(`Total Removed Gates Since last save: ${ gatesRemoved }`)
					const filename = outputPaths(problemName).progress(optimizedVersion.length)
					save([filename, outputPaths(problemName).latest], optimizedVersion, wires, originalGates)
					lastSaved = endTime
					prevSavedLength = optimizedVersion.length
				}
			}
		}
	}
}

export const splitTaskAndRun = async (pathToFileWithoutExt: string, original: string, circuits: JobCircuits = loadJob(pathToFileWithoutExt, original)) => {
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

	const { originalCircuit, inputCircuit } = circuits
	const originalGates: Gate[] = originalCircuit.gates.map((x) => ({ a: x[0], b: x[1], target: x[2], gate_i: x[3] }))
	const gates: Gate[] = inputCircuit.gates.map((x) => ({ a: x[0], b: x[1], target: x[2], gate_i: x[3] }))
	if (originalGates.length < gates.length) throw new Error('Original circuit is bigger than working. Do you have arguments the right way?')
	verifyCircuit(originalGates, gates, originalCircuit.wire_count, config.validation.checkpointInputs)
	const nMaxWorkers = configuredWorkerCount()
	const pool = new WorkerPool(nMaxWorkers)
	const paths = outputPaths(pathToFileWithoutExt)
	prepareOutputDirectories()
	let currentGates = gates.slice()
	const wireCosts = new Map<number, number>()
	let savedGateCount: number | undefined
	try {
		while(currentGates.length > 0) {
			currentGates = gateSimplifier(currentGates)
			let lastIterationTime = performance.now()
			const nPrevGates = currentGates.length
			const workersSize = getRandomNumberInRange(Math.min(config.workers.minimumChunkGates, currentGates.length), Math.max(1, currentGates.length * config.workers.maximumChunkFraction))
			const nWorkers = Math.max(1, Math.min(Math.floor(currentGates.length / workersSize), nMaxWorkers, currentGates.length || 1))
			const approxGates = config.search.balancedWorkers ? balancedChunks(currentGates, nWorkers, wireCosts) : splitArrayIntoApproximatelyChunks(currentGates, nWorkers)
			const candidateCounts = approxGates.map(chunk => chunk.length)
			const snapshots = approxGates.slice()
			const stopSignal = new Int32Array(new SharedArrayBuffer(4))
			const checkpoint = new ReductionCheckpoint(nPrevGates, snapshot => {
				save([paths.progress(snapshot.length), paths.latest], snapshot, inputCircuit.wire_count, originalGates)
				savedGateCount = snapshot.length
			})
			let rejectCheckpoint!: (error: unknown) => void
			const checkpointFailed = new Promise<never>((_, reject) => { rejectCheckpoint = reject })
			let completed = 0
			const statuses: WorkerStatus[] = approxGates.map(() => ({ updatedAtMs: 0, done: false }))
			const report = () => {
				const elapsed = performance.now() - lastIterationTime
				logVerbose(formatProgress(nPrevGates, candidateCounts.reduce((sum, count) => sum + count, 0), completed, nWorkers, elapsed))
				logVerbose(formatWorkerActivity(statuses, elapsed, WORKER_ROUND_MS))
				const snapshot = snapshots.flat()
				checkpoint.saveIfReduced(snapshot)
				logTimed(formatStatus({ original: originalGates.length, roundStart: nPrevGates, candidate: snapshot.length, saved: savedGateCount, statuses, elapsedMs: elapsed }))
				if (shouldFinishReducedRound(elapsed, nPrevGates, snapshot.length) && Atomics.load(stopSignal, 0) === 0) {
					Atomics.store(stopSignal, 0, 1)
					logTimed(`Improved-round target (${config.timing.improvedRoundMinutes} minutes) reached with gate reductions; finishing all workers between optimization steps.`)
				}
			}
			logTimed(`Round started: ${nPrevGates} gates across ${nWorkers} worker chunks; summaries every ${config.timing.summarySeconds} seconds`)
			const summaryTimer = setInterval(() => {
				try { report() }
				catch (error) { clearInterval(summaryTimer); rejectCheckpoint(error) }
			}, config.timing.summarySeconds * 1000)
			try {
				currentGates = (await Promise.race([checkpointFailed, Promise.all(approxGates.map(async (dataChunk, index) => {
					const workerFile = paths.worker(index)
					writeCircuit(workerFile, inputCircuit.wire_count, dataChunk)
					const jobStarted = performance.now()
					const result = await pool.run(dataChunk, inputCircuit.wire_count, (count, activity, snapshot) => {
							if (snapshot) snapshots[index] = snapshot
							candidateCounts[index] = count
							statuses[index] = { activity, updatedAtMs: performance.now() - lastIterationTime, done: false }
						}, stopSignal.buffer as SharedArrayBuffer)
					const cost = (performance.now() - jobStarted) / Math.max(1, dataChunk.length)
					for (const wire of new Set(dataChunk.flatMap(getVars))) wireCosts.set(wire, ((wireCosts.get(wire) ?? cost) + cost) / 2)
					candidateCounts[index] = result.length
					snapshots[index] = result
					completed++
					statuses[index].done = true
					writeCircuit(workerFile, inputCircuit.wire_count, result)
					return result
				}))])).flat()
			} finally {
				clearInterval(summaryTimer)
			}
			report()
			const filename = paths.progress(currentGates.length)
			if (!checkpoint.hasSaved) {
				save([filename, paths.latest], currentGates, inputCircuit.wire_count, originalGates)
				savedGateCount = currentGates.length
			} else checkpoint.saveIfReduced(currentGates)
			const gatesRemoved = nPrevGates - currentGates.length
			const endTime = performance.now()
			const timeDiffMins = (endTime - lastIterationTime) / 60000
			logTimed(`Total gates removed in iteration: ${ gatesRemoved } (${ Math.floor(gatesRemoved/timeDiffMins * 60) } gates/hour)`)
			shuffleRowsWithDependentGateSwap(currentGates, config.search.roundShufflePasses)
		}
	} finally {
		await pool.close()
	}
}
