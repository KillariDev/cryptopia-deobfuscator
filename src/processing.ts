import { circuitWireCost, isBetterCircuit, SplitCircuitCost } from './circuit-cost.js'
import { CheckpointWriter } from './checkpoint-writer.js'
import { opaqueRainbow } from './opaque-rainbow.js'
import { RoundStrategyPicker, StrategyPicker } from './strategy-picker.js'
import { searchDependencyCuts } from './dependency-cuts.js'
import { setImmediate as yieldToCoordinator } from 'node:timers/promises'
import { createPolynomialEquivalenceChecker } from './symbolic-affine.js'
import { structuralChoices, structuralNames, structuralRewrite, StructuralStrategy } from './structural-strategies.js'
import { mergeDisjointRoundResults, RoundCutPatches, roundSearchPlan, roundSearchResult } from './round-search.js'
import { formatRoundStrategies } from './logging.js'
import { recordStrategy, resetStrategyStats, strategySnapshot } from './strategy-stats.js'
import { selectIntervals } from './intervals.js'
import { AdaptiveConcurrency, MemoryConcurrency, memoryPressure, memorySnapshot } from './concurrency.js'
import { lookupDatabaseTime } from './lookup-statements.js'
import { loadSharedTables } from './shared-table.js'
import { ChunkedSequence } from './chunked-sequence.js'
import { SlidingWindowWires } from './window-wires.js'
import { LazyCircuit } from './circuit-edit.js'
import { IncrementalGraph } from './incremental-graph.js'
import { retainWindowKey, WindowFingerprints } from './fingerprints.js'
import { createHash } from 'node:crypto'
import { advancedRewrite, wholeCircuitAffineSearch, SynthesisBudget } from './strategies.js'
import { IncrementalEvaluator, PackedInputs } from './packed.js'
import { RewriteCache, SearchScheduler, balancedChunks, improving, SearchArm, NeighborhoodQueue, workerRegionSeed, createSearchArms, independentComponents } from './search.js'
import { config, minimumBroadGates } from './config.js'
import { formatCircuitSize, formatCoordinatorPhase, SummaryThrottle, verboseLogging, formatProgress, formatWorkerActivity, formatStatus, WorkerActivity, WorkerStatus, shouldFinishReducedRound, logVerbose } from './logging.js'
import { areBooleanArraysEqual, calculateAllOutputsArray, chunkArray, dependencyGraphToMap, dependencySort, evalCircuit, findConvexSubsets, generateCombinations, generateNRandomBooleanArray, getRandomNumberInRange, getVars, hashGates, ioHash, isReplacementSimpler, logTimed, mapCircuit, mapVariablesToIndexes, randomOrder, replace, reverseMapCircuit, simplifyGate, verifyCircuit } from './utils.js'
import { Gate } from './types.js'
import { RainbowPortfolio, RainbowMatch } from './rainbow-portfolio.js'
import { LimitedMap } from './limitedMap.js'
import { WorkerPool, configuredWorkerCount } from './threads.js'
import { createDependencyGraph } from './lineswapper.js'
import { outputPaths, prepareOutputDirectories, withPuzzleLock, writeCircuit, writeCircuitCopies, AsyncReductionCheckpoint } from './storage.js'
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

export function findMatchingOperation(gates: Gate[], shouldStop: () => boolean = () => false): { gateIndex1: number, gateIndex2: number, matchingVariable: number } | undefined {
	for (let i = 0; i < gates.length; i++) {
		for (let j = i + 1; j < gates.length; j++) {
			if (j % 256 === 0 && shouldStop()) return undefined
			const commonVariable = getCommonVariableIfTargetsMatch(gates[i], gates[j])
			if (commonVariable !== undefined) return { gateIndex1: i, gateIndex2: j, matchingVariable: commonVariable }
		}
	}
}

export function combineGates(gates: Gate[], shouldStop: () => boolean = () => false): { combined: boolean, gates: Gate[] } {
	const match = findMatchingOperation(gates, shouldStop)
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
	const inputs = sampledInputs(nVariables)
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
for (let wires = 1; wires < MAX_DETERMINISTIC_USELESS_VARS; wires++) {
	BYTE_ALL_INPUTS.set(wires, generateCombinations(wires))
}

const INPUTS = config.validation.probabilisticInputs
const randomInputs = generateNRandomBooleanArray(INPUTS, config.validation.maximumWires)
const randomInputSets = new Map<number, boolean[][]>()
const packedVariableSamples = new Map<number, PackedInputs>()
function sampledInputs(nVariables: number) {
	let inputs = randomInputSets.get(nVariables)
	if (!inputs) {
		inputs = randomInputs.map(input => input.slice(0, nVariables))
		randomInputSets.set(nVariables, inputs)
	}
	return inputs
}

/** The original region and samples are fixed for one variable search. */
function createVariableSampleCheck(original: Gate[], nVariables: number) {
	const inputs = sampledInputs(nVariables)
	let firstOutput: boolean[] | undefined
	let evaluator: IncrementalEvaluator | undefined
	return (candidate: Gate[]) => {
		if (!inputs.length) return true
		firstOutput ??= evalCircuit(original, inputs[0])
		if (!areBooleanArraysEqual(firstOutput, evalCircuit(candidate, inputs[0]))) return false
		if (inputs.length === 1) return true
		if (!evaluator) {
			let packed = packedVariableSamples.get(nVariables)
			if (!packed) {
				packed = new PackedInputs(inputs.slice(1))
				packedVariableSamples.set(nVariables, packed)
			}
			evaluator = new IncrementalEvaluator(original, packed, config.search.incrementalEvaluation ? config.search.prefixCacheBytes : 0, config.search.prefixStride)
		}
		return evaluator.equivalent(candidate)
	}
}

/** Raw operand positions preserve substitutions on unused operands too.
 * Active controls separately determine whether to try the control-only rewrite. */
function indexVariableUses(gates: Gate[], variableCount: number) {
	const uses = Array.from({ length: variableCount }, () => ({ all: [] as number[], controls: [] as number[], active: false, activeControl: false }))
	for (let i = 0; i < gates.length; i++) {
		const gate = gates[i]
		uses[gate.a]?.all.push(i)
		uses[gate.a]?.controls.push(i)
		if (gate.b !== gate.a) {
			uses[gate.b]?.all.push(i)
			uses[gate.b]?.controls.push(i)
		}
		if (gate.target !== gate.a && gate.target !== gate.b) uses[gate.target]?.all.push(i)
		const wires = getVars(gate)
		for (let j = 0; j < wires.length; j++) {
			const use = uses[wires[j]]
			use.active = true
			if (j > 0) use.activeControl = true
		}
	}
	return uses
}

const packedReferences = new WeakMap<boolean[][], { evaluator: IncrementalEvaluator, signature: string, attempts: number, wires: number }>()
const normalizedRewrites = new RewriteCache(config.search.normalizedCacheEntries)
const findProbabilisticUselessVars = (variableIndexMapping: number[], mappedGates: Gate[], shouldStop: () => boolean = () => false) => {
	if (shouldStop()) return undefined
	const nVariables = variableIndexMapping.length
	const canImprove = improving(mappedGates)
	if (nVariables < MAX_DETERMINISTIC_USELESS_VARS) return undefined // no need to do this approach for less than 8 vars as we have exact way already
	const proveEquivalent = createPolynomialEquivalenceChecker(mappedGates, nVariables, config.synthesis.affineMaximumTerms, config.synthesis.affineMaximumOperations, shouldStop)
	const sampleMatch = createVariableSampleCheck(mappedGates, nVariables)
	const accepted = (candidate: Gate[]) => sampleMatch(candidate) && proveEquivalent(candidate) === true
	if (accepted([])) return []
	
	const combined = combineGates(mappedGates, shouldStop)
	if (combined.combined) {
		if (canImprove(combined.gates) && accepted(combined.gates)) {
			return reverseMapCircuit(combined.gates, variableIndexMapping)
		}
	}
	
	const uses = indexVariableUses(mappedGates, nVariables)
	let simplified: Gate[] | undefined
	for (let variableIndex = 0; variableIndex < nVariables; variableIndex++) {
		if (shouldStop()) return undefined
		const newRemovedCircuit = removeVariable(mappedGates, variableIndex)
		if (canImprove(newRemovedCircuit) && accepted(newRemovedCircuit)) {
			return reverseMapCircuit(newRemovedCircuit, variableIndexMapping)
		}
		const { all, controls, active, activeControl: hasVariableIndexAsNontarget } = uses[variableIndex]
		if (hasVariableIndexAsNontarget) {
			const newRemovedCircuitNontarget = removeNonTargetVariable(mappedGates, variableIndex)
			if (canImprove(newRemovedCircuitNontarget) && accepted(newRemovedCircuitNontarget)) {
				return reverseMapCircuit(newRemovedCircuitNontarget, variableIndexMapping)
			}
		}
		for (let newVar = 0; newVar < nVariables; newVar++) {
			if (shouldStop()) return undefined
			if (variableIndexMapping[variableIndex] <= variableIndexMapping[newVar]) continue
			// Whole-wire replacement preserves gate/read counts. It only improves
			// the cost when two distinct active wires merge.
			if (active && uses[newVar].active) {
				const newCircuit = mappedGates.slice()
				for (const index of all) newCircuit[index] = replaceVar(mappedGates[index], variableIndex, newVar)
				if (accepted(newCircuit)) return reverseMapCircuit(newCircuit, variableIndexMapping)
			}
			
			if (hasVariableIndexAsNontarget) {
				simplified ??= mappedGates.map(simplifyGate)
				const newCircuit2 = simplified.slice()
				for (const index of controls) newCircuit2[index] = replaceNonTargetVar(mappedGates[index], variableIndex, newVar)
				if (sampleMatch(newCircuit2) && canImprove(newCircuit2) && proveEquivalent(newCircuit2) === true) {
					return reverseMapCircuit(newCircuit2, variableIndexMapping)
				}
			}
		}
	}
	return undefined
}

const findExactReplacement = (variableIndexMapping: number[], mappedGates: Gate[], shouldStop: () => boolean = () => false) => {
	if (shouldStop()) return undefined
	const nVariables = variableIndexMapping.length
	const allInputs = BYTE_ALL_INPUTS.get(nVariables)
	if (allInputs === undefined) return undefined
	const newVars = randomOrder(nVariables)
	const canImprove = improving(mappedGates)
	const expectedOutput = calculateAllOutputsArray(mappedGates, allInputs)
	if (areBooleanArraysEqual(expectedOutput, allInputs.flat())) return []
	for (let variableIndex = 0; variableIndex < nVariables; variableIndex++) {
		if (shouldStop()) return undefined
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
			if (shouldStop()) return undefined
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

const canceledVariables = Symbol('canceled variable search')
const findUselessVars = (mapping: number[], gates: Gate[], shouldStop: () => boolean = () => false) => {
	if (mapping.length > config.search.exactMaximumWires) return undefined
	let result: Gate[] | undefined
	try { result = normalizedRewrites.resolve(gates, canonical => {
		const value = findExactReplacement(Array.from({ length: mapping.length }, (_, i) => i), canonical, shouldStop)
		if (shouldStop()) throw canceledVariables
		return value
	}) } catch (error) { if (error === canceledVariables) return undefined; throw error }
	return result === undefined ? undefined : reverseMapCircuit(result, mapping)
}


type RainbowSliceMatch = {
	match: RainbowMatch
	replacement: Gate[]
	removed: number
	wireSavings: number
	readSavings: number
}

/** Successful slices can recur at several positions or in overlapping regions. */
class SliceResults {
	readonly variables = new LimitedMap<string, Gate[]>(1024)
	readonly rainbow = new LimitedMap<string, RainbowSliceMatch>(1024)
}

/** Reuse fingerprints across attempts on the same subset. */
export class SubsetPreparation {
	private fingerprints = new WeakMap<Gate[], WindowFingerprints>()
	constructor(readonly gates: Gate[], readonly results?: SliceResults) {}
	fingerprint(gates: Gate[]) {
		let value = this.fingerprints.get(gates)
		if (!value) { value = new WindowFingerprints(gates); this.fingerprints.set(gates, value) }
		return value
	}
}

type PreparedWindow = { variableIndexMapping: number[], mappedGates: Gate[] }

const optimizeVariables = (processedGatesCache: LimitedMap<string, boolean>, gates: Gate[], sliceSize: number, useProbabilistically: boolean, findUselessVarsSetting: boolean, rainbowTableWires: number, prepared: Map<number, PreparedWindow>, preparation: SubsetPreparation, shouldStop: () => boolean = () => false, onCandidate?: (gates: Gate[]) => void): { gates: Gate[], changed: boolean } => {
	if (sliceSize <= 2 || !findUselessVarsSetting) return { gates, changed: false }
	const replacements: { start: number, end: number, replacement: Gate[] }[] = []
	let fingerprints: WindowFingerprints | undefined
	let nextStart = 0
	let preparedRows = 0
	let uselessVarsFound = 0
	let uselessVarsFoundProb = 0
	const apply = (start: number, end: number, replacement: Gate[]) => {
		replacements.push({ start, end: end - 1, replacement })
		nextStart = end
		if (onCandidate) {
			onCandidate(replace(gates, replacements))
			onCandidate = undefined
		}
	}
	for (const window = new SlidingWindowWires(gates, sliceSize); window.next();) {
		if (shouldStop()) break
		const { start, end } = window
		if (start < nextStart) continue
		const eligible = window.wireCount <= config.search.exactMaximumWires || useProbabilistically
		const prepareForRainbow = window.wireCount <= rainbowTableWires && preparedRows + sliceSize <= 100_000
		if (!eligible && !prepareForRainbow) continue
		fingerprints ??= preparation.fingerprint(gates)
		if (fingerprints.seen(processedGatesCache, start, end)) continue
		const key = eligible && preparation.results ? fingerprints.exactKey(start, end) : undefined
		const previous = key === undefined ? undefined : preparation.results?.variables.get(key)
		if (previous !== undefined) {
			apply(start, end, previous)
			continue
		}
		const sliceGates = gates.slice(start, end)

		const variableIndexMapping = window.mapping() // counts are maintained across adjacent windows
		const mappedGates = mapCircuit(sliceGates, variableIndexMapping)
		if (prepareForRainbow) {
			prepared.set(start, { variableIndexMapping, mappedGates })
			preparedRows += mappedGates.length
		}
		if (!eligible) continue
		const replacement = findUselessVars(variableIndexMapping, mappedGates, shouldStop)
		if (replacement !== undefined) {
			const simplified = gateSimplifier(replacement)
			if (key !== undefined) preparation.results?.variables.set(retainWindowKey(key), simplified)
			apply(start, end, simplified)
			uselessVarsFound++
			continue
		}
		if (useProbabilistically) {
			const replacement = findProbabilisticUselessVars(variableIndexMapping, mappedGates, shouldStop)
			if (replacement !== undefined) {
				const simplified = gateSimplifier(replacement)
				if (key !== undefined) preparation.results?.variables.set(retainWindowKey(key), simplified)
				apply(start, end, simplified)
				uselessVarsFoundProb++
				continue
			}
		}
		if (shouldStop()) break
		if (variableIndexMapping.length <= rainbowTableWires) continue
		fingerprints.remember(processedGatesCache, start, end)
	}
	if (replacements.length === 0) return { gates, changed: false }
	const newCircuit = replace(gates, replacements)
	const diff = gates.length - newCircuit.length
	logVerbose(`VAR: Removed ${ diff } gates, exact simplified ${ uselessVarsFound } vars, probabilistically simplified ${ uselessVarsFoundProb } vars. With slice ${ sliceSize }`)
	return { gates: newCircuit, changed: true }
}

const adaptiveFailureCaches = new WeakMap<StrategyPicker | RoundStrategyPicker, Map<string, LimitedMap<string, boolean>>>()
const dependencySearches = new WeakMap<object, { picker: StrategyPicker, processed: LimitedMap<string, boolean>, offset: number }>()

export const massOptimizeStep = async (tables: RainbowPortfolio, ioIdentifierCache: LimitedMap<string, Gate[] | null>, processedGatesCache: LimitedMap<string, boolean>, originalGates: Gate[], sliceSize: number, useProbabilistically: boolean, findUselessVarsSetting: boolean, lookup = true, preparation = new SubsetPreparation(originalGates), synthesisBudget?: SynthesisBudget, strategyPicker?: StrategyPicker | RoundStrategyPicker): Promise<{ gates: Gate[], changed: boolean, unavailable?: true }> => {
	const attemptStarted = performance.now()
	lookup &&= config.search.rainbow
	const broadMinimum = synthesisBudget?.minimumBroadGates
	const wideOnly = broadMinimum !== undefined
	if (broadMinimum !== undefined && Math.min(originalGates.length, sliceSize) < broadMinimum) return { gates: originalGates, changed: false }
	const symbolic = config.synthesis.affine || config.synthesis.quadratic || structuralChoices().length > 0
	const maxSynthesis = Math.max(config.synthesis.maximumWindowGates, symbolic ? config.synthesis.affineMaximumWindowGates : 0)
	const wireCount = originalGates.length <= maxSynthesis ? new Set(originalGates.flatMap(getVars)).size : Infinity

	const smallEligible = !wideOnly && originalGates.length <= config.synthesis.maximumWindowGates && wireCount <= config.synthesis.maximumWires
	const symbolicEligible = !wideOnly && originalGates.length <= config.synthesis.affineMaximumWindowGates && wireCount <= config.validation.maximumWires
	const synthesisNames = [
		...((synthesisBudget?.broad || symbolicEligible) ? structuralChoices() : []),
		...(symbolicEligible && config.synthesis.affine ? ['gf2-affine'] : []),
		...(symbolicEligible && config.synthesis.quadratic ? ['quadratic'] : []),
		...(smallEligible && config.synthesis.forwardSemanticSearch ? ['forward-semantic-search'] : []),
		...(smallEligible && config.synthesis.smt ? ['z3'] : []),
		...(smallEligible && config.synthesis.meetInMiddle ? ['meet-in-the-middle'] : []),
		...(smallEligible && config.synthesis.equalitySaturation ? ['equality-saturation'] : []),
	]
	const available = [
		...(config.search.dependencyCuts && synthesisBudget?.broad && !synthesisBudget.dependencyRegion ? [{ name: 'dependency-cuts' }] : []),
		...(findUselessVarsSetting && sliceSize > 2 ? [{ name: 'variables' }] : []),
		...(lookup ? [{ name: 'rainbow' }] : []),
		...synthesisNames.map(name => ({ name })),
		...(synthesisBudget?.broad && (config.synthesis.affine || config.synthesis.quadratic) ? [{ name: 'symbolic' }] : []),
	]
	const selected = synthesisBudget?.selectedStrategy ?? (config.search.strategyAdaptive || synthesisBudget?.dependencyRegion ? strategyPicker?.pick(available)?.name : undefined)
	if (strategyPicker && config.search.strategyAdaptive && !selected) return { gates: originalGates, changed: false, unavailable: true }
	const runSynthesis = (!wideOnly && selected === undefined) || (selected !== undefined && synthesisNames.includes(selected))
	const selectedBudget = selected && runSynthesis ? { deadline: synthesisBudget?.deadline ?? performance.now() + config.workers.jobSeconds * 1000, ...synthesisBudget, selectedStrategy: selected } : synthesisBudget
	if (selected !== undefined && strategyPicker) {
		let caches = adaptiveFailureCaches.get(strategyPicker)
		if (!caches) { caches = new Map(); adaptiveFailureCaches.set(strategyPicker, caches) }
		let cache = caches.get(selected)
		if (!cache) { cache = new LimitedMap(Math.max(1, Math.floor(config.cache.processedEntries / 4))); caches.set(selected, cache) }
		processedGatesCache = cache
	}
	if (selected !== undefined) { findUselessVarsSetting &&= selected === 'variables'; lookup &&= selected === 'rainbow' }
	const finish = (result: { gates: Gate[], changed: boolean }) => {
		if (selected && strategyPicker instanceof RoundStrategyPicker) strategyPicker.observe(selected, originalGates.length - result.gates.length)
		return result
	}
	if (selected === 'dependency-cuts') {
		const key = strategyPicker ?? ioIdentifierCache
		let state = dependencySearches.get(key)
		if (!state) {
			state = { picker: new StrategyPicker(['rainbow', 'variables', ...structuralNames, 'symbolic', 'gf2-affine', 'quadratic', 'forward-semantic-search', 'z3', 'meet-in-the-middle', 'equality-saturation']), processed: new LimitedMap(config.cache.processedEntries), offset: 0 }
			dependencySearches.set(key, state)
		}
		const deadline = synthesisBudget?.deadline ?? performance.now() + config.workers.jobSeconds * 1000
		let lastProgress = performance.now()
		const stopped = () => {
			if (performance.now() - lastProgress >= config.timing.workerReportSeconds * 1000) { lastProgress = performance.now(); synthesisBudget?.onProgress?.() }
			return performance.now() >= deadline || synthesisBudget?.shouldStop?.() === true
		}
		const stats = { regions: 0, solverMs: 0 }
		const result = await searchDependencyCuts(originalGates, stopped, async cut => {
			const span = cut.indices[cut.indices.length - 1] - cut.indices[0] + 1
			if (span < (broadMinimum ?? 0)) return undefined
			const next = await massOptimizeStep(tables, ioIdentifierCache, state!.processed, cut.gates, cut.gates.length, useProbabilistically, config.search.variableElimination, true, new SubsetPreparation(cut.gates), { deadline, shouldStop: stopped, broad: true, dependencyRegion: true }, state!.picker)
			return next.changed ? next.gates : undefined
		}, state.offset++, stats, state, 2, originalGates.length, false, Infinity, synthesisBudget?.onCut)
		// Toolkit calls have their own timings; count only cut-index overhead here.
		recordStrategy('dependency-cuts', { global: true }, attemptStarted + stats.solverMs, originalGates.length, result?.length ?? originalGates.length, result !== undefined)
		return finish({ gates: result ?? originalGates, changed: result !== undefined })
	}
	if (selected === 'rainbow' && lookup && synthesisBudget?.dependencyRegion) {
		const result = await opaqueRainbow(originalGates, tables, ioIdentifierCache, () => performance.now() >= synthesisBudget.deadline || synthesisBudget.shouldStop?.() === true)
		if (result) { recordStrategy('rainbow', { opaque: true }, attemptStarted, originalGates.length, result.length, true); return finish({gates: result, changed:true}) }
	}
	if (selected === 'symbolic') {
		const result = wholeCircuitAffineSearch(originalGates, Math.max(0, (synthesisBudget?.deadline ?? performance.now()) - performance.now()), () => synthesisBudget?.shouldStop?.() === true)
		return finish({ gates: result, changed: result !== originalGates })
	}
	if (selected && (structuralNames as readonly string[]).includes(selected)) {
		const deadline = synthesisBudget?.deadline ?? performance.now() + config.workers.jobSeconds * 1000
		const canceled = () => synthesisBudget?.shouldStop?.() === true
		const whole = () => structuralRewrite(selected as StructuralStrategy, originalGates, deadline, canceled)
		let result: Gate[] | undefined
		if (selected === 'sat-sweeping' && synthesisBudget?.broad && !synthesisBudget.dependencyRegion && originalGates.length > 1024) {
			const stopped = () => performance.now() >= deadline || canceled()
			let lastProgress = performance.now()
			const cuts = (attempts: number) => searchDependencyCuts(originalGates, stopped, async cut => {
				if (performance.now() - lastProgress >= config.timing.workerReportSeconds * 1000) {
					lastProgress = performance.now()
					synthesisBudget.onProgress?.()
				}
				return structuralRewrite('sat-sweeping', cut.gates, deadline, stopped)
			}, 0, undefined, strategyPicker, broadMinimum, 1024, true, attempts, synthesisBudget.onCut)
			if (config.synthesis.broadSatCutsFirst) result = await cuts(8)
			if (!result && !stopped()) result = await whole()
			if (!result && !stopped()) result = await cuts(Infinity)
		} else result = await whole()
		return finish({ gates: result ?? originalGates, changed: result !== undefined })
	}
	const prepared = new Map<number, PreparedWindow>()
	if (preparation.gates !== originalGates) throw new Error('Subset preparation belongs to a different circuit')
	let strategyStarted = performance.now()
	const changes = optimizeVariables(processedGatesCache, originalGates, sliceSize, useProbabilistically, findUselessVarsSetting, lookup ? tables.maximumWires : 0, prepared, preparation, () => synthesisBudget?.shouldStop?.() === true || (synthesisBudget !== undefined && performance.now() >= synthesisBudget.deadline), synthesisBudget?.onCandidate)
	if (findUselessVarsSetting && sliceSize > 2) recordStrategy('variables', { slice: sliceSize, probabilistic: useProbabilistically, exactMaximumWires: config.search.exactMaximumWires }, strategyStarted, originalGates.length, changes.gates.length, changes.changed)
	if (!lookup) {
		if (runSynthesis && !changes.changed) { const candidate = await advancedRewrite(originalGates, selectedBudget); if (candidate) return finish({ gates: candidate, changed: true }) }
		return finish(changes)
	}
	const gates = changes.gates
	const fingerprints = preparation.fingerprint(gates)
	type Position = { start: number, end: number }
	type Query = PreparedWindow & { positions: Position[] }
	const queries = new Map<string, Query>()
	const replacements: { start: number, end: number, replacement: Gate[] }[] = []
	const candidates: (Position & RainbowSliceMatch)[] = []
	const remembered = preparation.results?.rainbow
	let onCandidate = synthesisBudget?.onCandidate
	let queryRows = 0, queuedWindows = 0
	let batchSize = onCandidate ? Math.min(64, config.database.queryBatchSize) : config.database.queryBatchSize
	strategyStarted = performance.now()
	const publishFirst = () => {
		if (!onCandidate || !candidates.length) return
		const selection = selectIntervals(candidates).map(({start, end, replacement}) => ({ start, end: end - 1, replacement }))
		if (!selection.length) return
		onCandidate(replace(gates, selection))
		onCandidate = undefined
	}
	const flushQueries = async () => {
		const entries = [...queries]
		const matches = await tables.findReplacements(entries.map(([, query]) => ({ mappedGates: query.mappedGates, wires: query.variableIndexMapping.length })), ioIdentifierCache)
		for (const [index, [key, query]] of entries.entries()) {
			const match = matches.get(index)
			if (!match) {
				const { start, end } = query.positions[0]
				fingerprints.remember(processedGatesCache, start, end)
				continue
			}
			const oldVariables = query.mappedGates.flatMap(getVars), newVariables = match.gates.flatMap(getVars)
			const result = {
				match, replacement: reverseMapCircuit(match.gates, query.variableIndexMapping),
				removed: query.mappedGates.length - match.gates.length,
				wireSavings: new Set(oldVariables).size - new Set(newVariables).size,
				readSavings: oldVariables.length - newVariables.length,
			}
			remembered?.set(retainWindowKey(key), result)
			for (const position of query.positions) candidates.push({ ...position, ...result })
		}
		queries.clear(); queryRows = 0; queuedWindows = 0
		batchSize = config.database.queryBatchSize
		publishFirst()
	}
	for (const window = new SlidingWindowWires(gates, sliceSize); window.next();) {
		if (synthesisBudget?.shouldStop?.() || (synthesisBudget && performance.now() >= synthesisBudget.deadline)) break
		const { start, end } = window
		if (end - start < (broadMinimum ?? 0) || window.wireCount > tables.maximumWires) continue
		if (fingerprints.seen(processedGatesCache, start, end)) continue
		const key = fingerprints.exactKey(start, end)
		const previous = remembered?.get(key)
		if (previous) { candidates.push({ start, end, ...previous }); publishFirst(); continue }
		const pending = queries.get(key)
		if (pending) pending.positions.push({ start, end })
		else {
			// The variable pass may already have mapped this window.
			const cached = changes.changed ? undefined : prepared.get(start)
			const variableIndexMapping = cached?.variableIndexMapping ?? window.mapping()
			const mappedGates = cached?.mappedGates ?? mapCircuit(gates.slice(start, end), variableIndexMapping)
			queries.set(key, { positions: [{ start, end }], variableIndexMapping, mappedGates })
			queryRows += mappedGates.length
		}
		queuedWindows++
		if (queryRows >= 100_000 || queuedWindows >= batchSize) await flushQueries()
	}
	if (queries.size) await flushQueries()
	for (const query of selectIntervals(candidates)) {
		tables.recordApplied(query.match, query.end - query.start)
		replacements.push({ start: query.start, end: query.end - 1, replacement: query.replacement })
	}
	recordStrategy('rainbow', { slice: sliceSize, maximumWires: tables.maximumWires }, strategyStarted, gates.length, gates.length - replacements.reduce((sum, entry) => sum + entry.end - entry.start + 1 - entry.replacement.length, 0), replacements.length > 0)
	if (replacements.length === 0) {
		if (runSynthesis && !changes.changed) { const candidate = await advancedRewrite(originalGates, selectedBudget); if (candidate) return finish({ gates: candidate, changed: true }) }
		return finish(changes)
	}
	const newCircuit = replace(gates, replacements)
	const diff = gates.length - newCircuit.length
	if (diff > 0) logVerbose(`Rainbow: Removed ${ diff } gates with slice ${ sliceSize }`)
	return finish({ gates: newCircuit, changed: true })
}

const gateSimplifier = (gates: Gate[]) => gates.map((gate) => simplifyGate(gate))

const save = (filenames: string[], gates: Gate[], wires: number, originalGates: Gate[]) => {
	gates = gateSimplifier(gates)
	logVerbose(`Saving a version with ${ gates.length } gates to ${ filenames.join(', ') } (${ Math.floor(gates.length/originalGates.length*100) }% of original)`)
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
export function shuffleRowsWithDependentGateSwap(gates: Gate[], times: number, shouldStop: () => boolean = () => false) {
	const hasCommonNumber = (arr1: number, arr2: number[]): boolean => {
		return arr2.includes(arr1)
	}

	const swapDependingGates = (gates: Gate[], previous: number, current: number, previousDependsOnThis: boolean, thisDependsOnPrevious: boolean) => {
		const sliceGates = [gates[previous], gates[current]]
		const variableIndexMapping = mapVariablesToIndexes(sliceGates) // map variables to smaller amount of wires
		const nVariables = variableIndexMapping.length
		if (nVariables < 2) return
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
			if (shouldStop()) return
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
			if ((gateI & 63) === 1 && shouldStop()) return
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

export const optimizeSubset = async (tables: RainbowPortfolio, slicedVersion: Gate[], ioIdentifierCache: LimitedMap<string, Gate[] | null>, processedGatesCache: LimitedMap<string, boolean>, subsetSize: number, maxSlice: number, phase: 'simplest' | 'heavy', timeToEndWorker: () => boolean, activity: WorkerActivity, onCandidate: (gates: Gate[]) => void, testedSubsets: LimitedMap<string, boolean>, method: SearchArm['method'], onLazyCandidate?: (gates: ChunkedSequence<Gate>) => void, synthesisBudget?: SynthesisBudget, strategyPicker?: StrategyPicker | RoundStrategyPicker, initialSeed?: number, sliceResults?: SliceResults): Promise<Gate[]> => {
	// No convex region can reach the requested size in this chunk.
	if (subsetSize > slicedVersion.length) return slicedVersion.slice()
	const useProbabilistically = method !== 'rainbow' && phase === 'heavy' && config.search.probabilistic
	const findUselessVarsSetting = method !== 'rainbow' && config.search.variableElimination
	const active = config.search.strategyAdaptive && strategyPicker instanceof RoundStrategyPicker ? strategyPicker.activeStrategy : undefined
	const useLegacyCache = !(config.search.strategyAdaptive && strategyPicker)
	const attemptBudget = useLegacyCache
		? { deadline: performance.now() + config.workers.jobSeconds * 1000, ...synthesisBudget, exhaustStrategies: true }
		: synthesisBudget
	const firstSlice = active === 'variables' ? Math.max(3, config.search.sliceMinimum) : config.search.sliceMinimum
	const lastSlice = active && active !== 'rainbow' && active !== 'variables' ? firstSlice : maxSlice
	let regenerateGraph = false
	let changedWires = new Set<number>()
	const neighborhoods = new NeighborhoodQueue(config.search.localSearchSeeds, config.search.localSearchRadius, config.search.localSearchBroadEvery)
	const circuit = new ChunkedSequence(slicedVersion, config.search.circuitChunkGates)
	activity.stage = 'preparing'
	if (timeToEndWorker()) return circuit.toArray()
	const graph = config.search.incrementalDependencies ? new IncrementalGraph(slicedVersion, config.search.circuitChunkGates, { trackFuture: false }) : undefined
	do {
		if (subsetSize > circuit.length) break
		activity.stage = 'preparing'
		const preferred = config.search.prioritizeChangedWires ? changedWires : undefined
		const seeds = config.search.localSearch ? neighborhoods.take() : []
		if (initialSeed !== undefined) { seeds.unshift(initialSeed); initialSeed = undefined }
		const stopped = () => { activity.stage = 'preparing'; return timeToEndWorker() }
		const graphIterator = graph ? graph.regions(subsetSize, config.search.localSearch && !seeds.length ? undefined : preferred, seeds, stopped) : findConvexSubsets(subsetSize, circuit, preferred, undefined, seeds, stopped)
		regenerateGraph = false
		for (let lines of graphIterator) {
			activity.stage = 'searching'
			const subsetKey = useLegacyCache ? `${maxSlice}:${method}:${phase}:${hashGates(lines.map(line => circuit.at(line)))}` : undefined
			if (subsetKey && testedSubsets.has(subsetKey)) continue
			let subsetChanged = false
			activity.subsets++
			while (lines.length) {
				const inGates = lines.map(line => circuit.at(line))
				let preparation: SubsetPreparation | undefined
				const gateKey = active ? createHash('sha256').update(hashGates(inGates)).digest('base64') : undefined
				let changed = false
				for (let slice = firstSlice; slice <= Math.min(lastSlice, lines.length); slice++) {
					if (timeToEndWorker()) return circuit.toArray()
					const attemptKey = active ? `${active}:${method}:${phase}:${slice}:${gateKey}` : undefined
					if (attemptKey && testedSubsets.has(attemptKey)) continue
					activity.checks++
					const optimizationOutput = await massOptimizeStep(tables, ioIdentifierCache, processedGatesCache, inGates, slice, useProbabilistically, findUselessVarsSetting, method !== 'variables', preparation ??= new SubsetPreparation(inGates, sliceResults), attemptBudget, strategyPicker)
					if (!optimizationOutput.changed) {
						if (timeToEndWorker() || (attemptBudget && (performance.now() >= attemptBudget.deadline || attemptBudget.shouldStop?.()))) return circuit.toArray()
						if (attemptKey && !optimizationOutput.unavailable) testedSubsets.set(attemptKey, true)
						continue
					}
					subsetChanged = true; changed = true; activity.improvements++
					changedWires = new Set([...inGates, ...optimizationOutput.gates].flatMap(getVars))
					const nodes = createDependencyGraph(optimizationOutput.gates)
					const dependantMap = dependencyGraphToMap(nodes)
					const newGates = (nodes.length === 0 ? [] : appendMissingNumbers(dependencySort(dependantMap, nodes[nodes.length - 1], nodes.length, nodes, optimizationOutput.gates), nodes.length)).map(x => optimizationOutput.gates[x])
					const start = circuit.replace(lines, newGates)
					graph?.replace(lines, newGates)
					neighborhoods.afterRewrite(start, newGates.length, circuit.length)
					if (onLazyCandidate) onLazyCandidate(circuit)
					else onCandidate(circuit.toArray())
					lines = Array.from({ length: newGates.length }, (_, i) => start + i)
					regenerateGraph = true
					break
				}
				if (!changed) break
			}
			if (!subsetChanged && subsetKey) testedSubsets.set(subsetKey, true)
			if (regenerateGraph) {
				break
			}
		}
	} while(regenerateGraph)
	return circuit.toArray()
}

const standaloneStructural = () => [
	...(config.synthesis.factored ? ['factored'] : []),
	...(config.synthesis.blockCancellation ? ['block-cancellation'] : []),
	...(config.synthesis.satSweeping ? ['sat-sweeping'] : []),
	...(config.synthesis.mixedBasis ? ['mixed-basis'] : []),
]
const variableStrategy = () => config.search.variableElimination && config.search.sliceMaximum >= 3 ? ['variables'] : []
const smallSynthesisStrategies = new Set(['forward-semantic-search', 'equality-saturation', 'z3', 'meet-in-the-middle'])
const localStrategyOrder = () => [
	...(config.search.rainbow ? ['rainbow'] : []), ...(config.search.subsetMaximum >= 3 ? variableStrategy() : []),
	...(config.synthesis.forwardSemanticSearch ? ['forward-semantic-search'] : []),
	...(config.synthesis.equalitySaturation ? ['equality-saturation'] : []),
	...(config.synthesis.affine ? ['gf2-affine'] : []),
	...(config.synthesis.quadratic ? ['quadratic'] : []),
	...standaloneStructural(),
	...(config.synthesis.smt ? ['z3'] : []),
	...(config.synthesis.meetInMiddle ? ['meet-in-the-middle'] : []),
].filter(strategy => !smallSynthesisStrategies.has(strategy) || config.search.subsetMinimum <= config.synthesis.maximumWindowGates)
export const broadStrategyOrder = () => [
	...(config.synthesis.satSweeping ? ['sat-sweeping'] : []),
	...(config.synthesis.mixedBasis ? ['mixed-basis'] : []),
	...(config.synthesis.blockCancellation ? ['block-cancellation'] : []),
	...(config.synthesis.affine || config.synthesis.quadratic ? ['symbolic'] : []),
	...(config.synthesis.factored ? ['factored'] : []),
	...(config.search.dependencyCuts ? ['dependency-cuts'] : []),
]
export const createOptimizerCaches = (workerIndex = 0) => ({
	workerIndex,
	strategyPicker: new RoundStrategyPicker(localStrategyOrder(), workerIndex),
	broadStrategyPicker: new RoundStrategyPicker(broadStrategyOrder(), workerIndex),
	broadFallbackPicker: new StrategyPicker(broadStrategyOrder()),
	ioIdentifierCache: new LimitedMap<string, Gate[] | null>(config.cache.lookupEntries, config.cache.lookupPolicy),
	processedGatesCache: new LimitedMap<string, boolean>(config.cache.processedEntries),
	arms: createSearchArms(config.search.searchArms, config.search.subsetMinimum, config.search.subsetMaximum, config.search.sliceMinimum, config.search.sliceMaximum),
	scheduler: new SearchScheduler(config.search.explorationEvery, config.search.schedulerDecay, config.search.schedulerHistoryEntries),
	testedSubsets: new LimitedMap<string, boolean>(config.cache.subsetEntries),
	methodCaches: new Map<string, LimitedMap<string, boolean>>(),
})

export const optimize = async (tables: RainbowPortfolio, originalGates: Gate[], wires: number, problemName: string, workerMode: boolean, caches = createOptimizerCaches(), roundDurationMs = WORKER_ROUND_MS, onProgress?: (gates: number, activity: WorkerActivity, snapshot?: Gate[]) => void, shouldFinish?: (activity?: WorkerActivity) => boolean, wantsSnapshot?: (gates: number, improvements: number) => boolean, reportOnImprovement = false) => {
	resetStrategyStats()
	const jobStarted = performance.now(), jobDeadline = jobStarted + roundDurationMs, databaseStarted = lookupDatabaseTime()
	let optimizedVersion = originalGates.slice()
	let prevSavedLength = originalGates.length
	const simplifyStarted = performance.now()
	optimizedVersion = gateSimplifier(optimizedVersion)
	recordStrategy('gate-simplification', {}, simplifyStarted, originalGates.length, optimizedVersion.length, optimizedVersion.length < originalGates.length)
	verifyCircuit(originalGates, optimizedVersion, wires, config.validation.checkpointInputs)
	let lastSaved = performance.now()
	const { ioIdentifierCache, processedGatesCache } = caches
	
	tables.resetStatistics()
	const strategy = config.search.strategyAdaptive ? caches.strategyPicker.activeStrategy : undefined
	const scanContiguous = strategy === 'variables' || (strategy === 'rainbow' && tables.maximumWires > 0)
	const sliceResults = scanContiguous ? new SliceResults() : undefined
	const minimumSubset = strategy === 'variables' ? Math.max(3, config.search.subsetMinimum) : config.search.subsetMinimum
	const maximumSubset = strategy && smallSynthesisStrategies.has(strategy)
		? Math.min(config.search.subsetMaximum, config.synthesis.maximumWindowGates)
		: config.search.subsetMaximum
	const chooseSubsetSize = () => getRandomNumberInRange(minimumSubset, maximumSubset + 1)
	let subsetSize = chooseSubsetSize()
	let maxSlice = getRandomNumberInRange(config.search.sliceMinimum, config.search.sliceMaximum + 1)
	let phase: 'simplest' | 'heavy' = 'heavy'
	const arms = !config.search.adaptive ? [] : config.search.stableSearchArms ? caches.arms : createSearchArms(config.search.searchArms, config.search.subsetMinimum, config.search.subsetMaximum, config.search.sliceMinimum, config.search.sliceMaximum).map(arm => ({ ...arm, subset: getRandomNumberInRange(config.search.subsetMinimum, config.search.subsetMaximum + 1), slice: getRandomNumberInRange(config.search.sliceMinimum, config.search.sliceMaximum + 1) }))
	//logTimed(`optimizer started with subset ${subsetSize}`)
	const activity: WorkerActivity = { passes: 0, subsets: 0, checks: 0, improvements: 0, stage: 'searching' }
	const progressActivity = (): WorkerActivity => ({ ...activity, activeStrategy: config.search.strategyAdaptive ? caches.strategyPicker.activeStrategy : undefined, strategies: strategySnapshot(), rainbowTables: tables.statistics(), resources: { databaseMs: lookupDatabaseTime() - databaseStarted, elapsedMs: performance.now() - jobStarted, heapUsedBytes: process.memoryUsage().heapUsed } })
	let lastProgress = performance.now()
	let publishedReduction = false
	let candidateParts = new LazyCircuit([optimizedVersion])
	onProgress?.(optimizedVersion.length, progressActivity(), optimizedVersion)
	const finishWorker = () => {
		activity.stage = 'verifying'
		onProgress?.(optimizedVersion.length, progressActivity(), optimizedVersion)
		verifyCircuit(originalGates, optimizedVersion, wires, config.validation.checkpointInputs)
		return optimizedVersion
	}
	const timeToEndWorker = () => {
		const endTime = performance.now()
		if (onProgress) {
			const periodic = endTime - lastProgress >= config.timing.workerReportSeconds * 1000
			if (periodic || (reportOnImprovement && !publishedReduction)) {
				const improved = wantsSnapshot?.(candidateParts.length, activity.improvements)
				if (periodic || improved) {
					if (improved) publishedReduction = true
					onProgress(candidateParts.length, progressActivity(), improved || !wantsSnapshot ? candidateParts.materialize() : undefined)
					lastProgress = endTime
				}
			}
		}
		return shouldFinish?.(activity) === true || endTime >= jobDeadline
	}
	const heartbeat = onProgress ? setInterval(() => {
		const improved = wantsSnapshot?.(candidateParts.length, activity.improvements)
		onProgress(candidateParts.length, progressActivity(), improved ? candidateParts.materialize() : undefined)
		lastProgress = performance.now()
		if (improved) publishedReduction = true
	}, config.timing.workerReportSeconds * 1000) : undefined
	try {
	while (true) {
		if (workerMode && optimizedVersion.length === 0) return finishWorker()
		//shuffleRows(optimizedVersion, 20)
		let method: SearchArm['method'] = 'all'
		if (config.search.adaptive) {
			const selected = caches.scheduler.choose(arms)
			subsetSize = selected.subset
			maxSlice = selected.slice
			if (!config.search.strategyAdaptive) method = selected.method
		}
		subsetSize = Math.max(minimumSubset, Math.min(subsetSize, maximumSubset))
		if (strategy === 'variables') maxSlice = Math.max(3, maxSlice)
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
		if (activity.passes === 1 && scanContiguous) {
			const first = strategy === 'variables' ? Math.max(3, config.search.sliceMinimum) : config.search.sliceMinimum
			let preparation = new SubsetPreparation(optimizedVersion, sliceResults)
			let key = createHash('sha256').update(hashGates(optimizedVersion)).digest('base64')
			// Start with the shortest size for variables and up to two for
			// rainbow. Graph search still covers longer and noncontiguous windows.
			const last = strategy === 'variables' ? first : first + 1
			for (let size = first; size <= Math.min(last, maxSlice, optimizedVersion.length); size++) {
				if (timeToEndWorker()) break
				const attempt = `contiguous:${strategy}:${phase}:${size}:${key}`
				if (caches.testedSubsets.has(attempt)) continue
				activity.subsets++
				activity.checks++
				let published = false
				const budget: SynthesisBudget = { deadline: jobDeadline, shouldStop: timeToEndWorker }
				if (reportOnImprovement && onProgress && !publishedReduction) budget.onCandidate = gates => {
					published = true
					activity.improvements++
					candidateParts = new LazyCircuit([gates])
					timeToEndWorker()
				}
				const result = await massOptimizeStep(tables, ioIdentifierCache, methodCache, optimizedVersion, size,
					config.search.probabilistic && phase === 'heavy', config.search.variableElimination, true,
					preparation, budget, caches.strategyPicker)
				if (result.changed) {
					if (!published) activity.improvements++
					optimizedVersion = result.gates
					candidateParts = new LazyCircuit([optimizedVersion])
					preparation = new SubsetPreparation(optimizedVersion, sliceResults)
					key = createHash('sha256').update(hashGates(optimizedVersion)).digest('base64')
				}
				if (timeToEndWorker()) break
				if (!result.changed && !result.unavailable) caches.testedSubsets.set(attempt, true)
			}
			if (workerMode && (!optimizedVersion.length || timeToEndWorker())) return finishWorker()
		}
		const nChunks = Math.max(1, Math.min(config.search.maximumInnerChunks, Math.floor(optimizedVersion.length / config.search.minimumInnerChunkGates)))
		const components = config.search.independentComponents ? independentComponents(optimizedVersion) : [optimizedVersion]
		const chunked = components.flatMap(component => chunkArray(component, Math.max(1, Math.min(component.length, Math.floor(nChunks / components.length)))))
		candidateParts = new LazyCircuit(chunked)
		await Promise.all(chunked.map(async (data, index) => {
			const result = await optimizeSubset(tables, data, ioIdentifierCache, methodCache!, subsetSize, maxSlice, phase, timeToEndWorker, activity, () => {}, caches.testedSubsets, method, gates => {
				candidateParts.update(index, gates)
				timeToEndWorker()
			}, { deadline: jobDeadline, shouldStop: () => shouldFinish?.(activity) === true }, caches.strategyPicker, workerRegionSeed(data.length, caches.workerIndex), sliceResults)
			candidateParts.update(index, result)
			return result
		}))
		optimizedVersion = candidateParts.materialize()
		caches.scheduler.record(selection, performance.now() - searchStarted, startLength - optimizedVersion.length)
		/*if (phase === 'heavy' && config.search.probabilistic) {
			shuffleRowsWithDependentGateSwap(optimizedVersion, 1)
			maxSlice++
			if (maxSlice > subsetSize) subsetSize++
			if (maxSlice > optimizedVersion.length) return
		}*/
		//else if (optimizedVersion.length < startLength) {
			activity.stage = 'shuffling'
			if (!timeToEndWorker()) shuffleRowsWithDependentGateSwap(optimizedVersion, config.search.workerShufflePasses, timeToEndWorker)
			subsetSize = chooseSubsetSize()
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
				return finishWorker()
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
	} finally { clearInterval(heartbeat) }
}

export function splitTaskAndRun(pathToFileWithoutExt: string, original: string, input?: JobCircuits | (() => Promise<JobCircuits>), onPhase: (phase: string) => void = () => {}, initializeTables?: () => Promise<void>) {
	return withPuzzleLock(pathToFileWithoutExt, async () => {
		const circuits = typeof input === 'function' ? await input() : input ?? loadJob(pathToFileWithoutExt, original)
		await runPuzzle(pathToFileWithoutExt, circuits, onPhase, initializeTables)
	})
}

async function runPuzzle(pathToFileWithoutExt: string, circuits: JobCircuits, onPhase: (phase: string) => void, initializeTables?: () => Promise<void>) {
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
	if (originalCircuit.wire_count !== inputCircuit.wire_count) throw new Error('Latest circuit wire count differs from original')
	if (originalGates.length < gates.length) throw new Error('Latest circuit has more gates than original')
	onPhase('verifying input checkpoint')
	const writer = new CheckpointWriter(originalGates, inputCircuit.wire_count, config.validation.checkpointInputs)
	try {
		await writer.write([outputPaths(pathToFileWithoutExt).latest], gates, inputCircuit !== originalCircuit)
		if (gates.length) await initializeTables?.()
	} catch (error) {
		await writer.close()
		throw error
	}
	if (!gates.length) { await writer.close(); return }
	const nMaxWorkers = configuredWorkerCount()
	onPhase('loading shared rainbow table snapshots')
	const sharedTables = config.search.rainbow ? await loadSharedTables() : []
	onPhase('starting optimizer workers')
	const initialWorkers = Math.min(nMaxWorkers, Math.max(4, config.workers.initialConcurrency))
	logTimed(`Starting optimizer with ${initialWorkers} workers, up to ${nMaxWorkers} as memory allows${config.workers.keepBusy ? ' (continuous scheduling)' : ''}.`)
	const pool = new WorkerPool(nMaxWorkers, undefined, sharedTables)
	const memoryLimit = new MemoryConcurrency(nMaxWorkers, initialWorkers)
	let requestedConcurrency = nMaxWorkers, activeConcurrency = initialWorkers, adjustingMemory = false
	let rejectMemory!: (error: Error) => void
	const memoryFailure = new Promise<never>((_, reject) => { rejectMemory = reject })
	void memoryFailure.catch(() => {})
	const monitorMemory = async () => {
		if (adjustingMemory) return
		const sample = memorySnapshot(config.workers.memoryBudgetMegabytes)
		if (activeConcurrency === 1 && sample.pressure >= 1.1) {
			rejectMemory(new Error(`Memory budget exceeded with one worker (${Math.round(sample.rss / 1048576)} MB resident, ${Math.round(sample.budget / 1048576)} MB budget). Checkpoint retained; reduce graph limits or free memory.`))
			return
		}
		const next = memoryLimit.observe(performance.now(), sample.pressure, activeConcurrency)
		if (next === undefined) return
		const limit = memoryLimit.limit(requestedConcurrency)
		if (limit === activeConcurrency) return
		adjustingMemory = true
		const previous = activeConcurrency; activeConcurrency = limit
		const reportMemory = limit < previous ? logTimed : logVerbose
		reportMemory(`Memory: ${Math.round(sample.rss / 1048576)} / ${Math.round(sample.budget / 1048576)} MB; worker limit ${previous} -> ${limit}.`)
		try { if (limit < previous) await pool.trimForMemory(limit); else pool.setConcurrency(limit) }
		catch (error) { rejectMemory(error instanceof Error ? error : new Error(String(error))) }
		finally { adjustingMemory = false }
	}
	const concurrency = new AdaptiveConcurrency(nMaxWorkers, config.workers.initialConcurrency, config.workers.concurrencySampleRounds, config.workers.concurrencyDatabaseFraction, config.workers.concurrencyRateTolerance)
	const paths = outputPaths(pathToFileWithoutExt)
	prepareOutputDirectories()
	let currentGates = gates.slice()
	const wireCosts = new Map<number, number>()
	let lastReportedGates = currentGates.length
	let lastReportedPairs = circuitWireCost(currentGates).effectivePairs
	let optimizerRound = 0
	const globalStrategyPicker = new RoundStrategyPicker(broadStrategyOrder())
	const completedBroadScans = new LimitedMap<string, Set<string>>(2, 'lru')
	const summaryThrottle = new SummaryThrottle(config.timing.summarySeconds * 1000)
	let reportStatus: (force?: boolean) => void = () => {}
	const beginPhase = (phase: string) => {
		const started = performance.now()
		reportStatus = (force = false) => {
			if (!summaryThrottle.allow(performance.now(), force || verboseLogging())) return
			const effectivePairs = circuitWireCost(currentGates).effectivePairs
			logTimed(formatCoordinatorPhase(currentGates.length, effectivePairs, originalGates.length, lastReportedGates, lastReportedPairs, phase, performance.now() - started))
			lastReportedPairs = effectivePairs
			lastReportedGates = currentGates.length
		}
	}
	beginPhase('preparing next round')
	// One timer for the entire run; it is never reset at round boundaries.
	const summaryTimer = setInterval(() => reportStatus(true), config.timing.summarySeconds * 1000)
	const memoryTimer = setInterval(monitorMemory, 500)
	try {
		while(currentGates.length > 0) {
			onPhase('running optimizer searches')
			optimizerRound++
			const roundStrategies = {
				Local: new Map<string, WorkerActivity>(),
				Global: new Map<string, WorkerActivity>(),
			}
			const observeStrategy = (side: keyof typeof roundStrategies, activity?: WorkerActivity) => {
				const assignments = roundStrategies[side]
				if (activity?.workerId !== undefined && activity.activeStrategy) {
					assignments.set(`${activity.workerId}:${activity.activeStrategy}`, activity)
				}
			}
			beginPhase('preparing next round')
			currentGates = gateSimplifier(currentGates)
			let lastIterationTime = performance.now()
			const nPrevGates = currentGates.length
			let winner: 'local' | 'global' | 'combined' = 'local'
			const workersSize = getRandomNumberInRange(Math.min(config.workers.minimumChunkGates, currentGates.length), Math.max(1, currentGates.length * config.workers.maximumChunkFraction))
			const broadEnabled = nMaxWorkers > 1 && currentGates.length >= minimumBroadGates() && config.workers.broadSearchSeconds > 0 && globalStrategyPicker.activeStrategy !== undefined
			if (broadEnabled) globalStrategyPicker.beginRound(optimizerRound)
			const broadInput = currentGates
			const broadKey = broadEnabled ? hashGates(broadInput) : undefined
			const completedBroad = broadKey === undefined ? undefined : completedBroadScans.get(broadKey)
			const globalStrategy = config.search.strategyAdaptive
				? completedBroad ? globalStrategyPicker.skipExhausted(completedBroad) : globalStrategyPicker.activeStrategy
				: undefined
			const runBroad = broadEnabled && (config.search.strategyAdaptive ? !!globalStrategy : !completedBroad?.has(''))
			const plan = roundSearchPlan(currentGates.length, nMaxWorkers, workersSize, config.workers.wholeCircuitMaximumGates)
			const wholeCircuit = plan.wholeCircuit || (config.workers.keepBusy && currentGates.length < nMaxWorkers)
			requestedConcurrency = config.workers.keepBusy ? nMaxWorkers : config.workers.adaptiveConcurrency ? Math.max(runBroad ? 2 : 1, concurrency.limit(Math.min(nMaxWorkers, plan.capacity + Number(runBroad)))) : Math.min(nMaxWorkers, plan.capacity + Number(runBroad))
			const nWorkers = memoryLimit.limit(requestedConcurrency)
			activeConcurrency = nWorkers
			pool.setConcurrency(nWorkers)
			pool.setBroadReservation(runBroad)
			// Queue enough independent lanes for the requested capacity so staged
			// startup can fill newly available slots within this same round.
			const queueCapacity = config.workers.keepBusy ? requestedConcurrency : nWorkers
			const localWorkers = Math.max(1, queueCapacity - Number(runBroad && queueCapacity > 1))
			const requestedJobs = config.workers.keepBusy ? Math.max(nWorkers, localWorkers * config.workers.jobsPerWorker) : localWorkers * config.workers.jobsPerWorker
			const jobCount = wholeCircuit ? requestedJobs : Math.min(currentGates.length, requestedJobs)
			const approxGates = wholeCircuit ? Array.from({ length: jobCount }, () => currentGates.slice()) : config.search.balancedWorkers ? balancedChunks(currentGates, jobCount, wireCosts) : splitArrayIntoApproximatelyChunks(currentGates, jobCount)
			const candidateCounts = approxGates.map(chunk => chunk.length)
			const snapshots = approxGates.slice()
			const splitCost = wholeCircuit ? undefined : new SplitCircuitCost(snapshots)
			const stopSignal = new Int32Array(new SharedArrayBuffer(4))
			const checkpoint = new AsyncReductionCheckpoint(currentGates, async snapshot => {
				await writer.write([paths.progress(snapshot.length), paths.latest], snapshot)
			})

			let rejectCheckpoint!: (error: unknown) => void
			const checkpointFailed = new Promise<never>((_, reject) => { rejectCheckpoint = reject })
			let completed = 0
			const statuses: WorkerStatus[] = Array.from({ length: jobCount + Number(runBroad) }, () => ({ updatedAtMs: 0, done: false, started: false }))
			const localCandidate = () => roundSearchResult(snapshots, wholeCircuit)
			const localCount = () => wholeCircuit ? Math.min(...candidateCounts) : candidateCounts.reduce((sum, count) => sum + count, 0)
			let broadBest = currentGates
			const roundPatches = runBroad && !wholeCircuit ? new RoundCutPatches(nPrevGates) : undefined
			let bestObserved = currentGates
			let bestObservedSide: 'local' | 'global' = 'local'
			let pendingCheckpoint = false
			let checkpointFlush: Promise<void> | undefined
			const flushCheckpoint = async (): Promise<void> => {
				if (checkpointFlush) return checkpointFlush
				if (!pendingCheckpoint) return
				const local = localCandidate()
				const candidate = roundSearchResult([local, broadBest], true)
				if (isBetterCircuit(candidate, bestObserved)) {
					bestObserved = candidate
					bestObservedSide = candidate === local ? 'local' : 'global'
				}
				pendingCheckpoint = false
				checkpointFlush = checkpoint.saveIfReduced(bestObserved).then(() => {})
				try { await checkpointFlush } finally { checkpointFlush = undefined }
			}
			const checkpointTimer = setInterval(() => {
				void flushCheckpoint().catch(error => { Atomics.store(stopSignal, 0, 1); rejectCheckpoint(error) })
			}, config.timing.checkpointSeconds * 1000)
			const report = (force = false, roundResult?: Gate[], elapsed = performance.now() - lastIterationTime) => {
				if (config.workers.keepBusy) logVerbose(`Jobs finished this round: ${completed}; continuing searches across ${jobCount} ${wholeCircuit ? 'whole-circuit alternatives' : 'chunks'}.`)
				else logVerbose(formatProgress(nPrevGates, (wholeCircuit ? Math.min(...candidateCounts) : candidateCounts.reduce((sum, count) => sum + count, 0)), completed, jobCount, elapsed))
				logVerbose(formatWorkerActivity(statuses, elapsed, WORKER_ROUND_MS))
				const localGates = localCount()
				const candidate = roundResult?.length ?? Math.min(broadBest.length, localGates)
				if (summaryThrottle.allow(performance.now(), force || verboseLogging() || candidate === 0)) {
					const best = roundResult ?? (broadBest.length < localGates ? broadBest : roundSearchResult([localCandidate(), broadBest], true))
					const effectivePairs = circuitWireCost(best).effectivePairs
					logTimed(formatStatus({ effectivePairs, previousPairs: lastReportedPairs, original: originalGates.length, roundStart: nPrevGates, candidate, roundImproved: localGates < nPrevGates, previous: lastReportedGates, statuses, elapsedMs: elapsed }))
					lastReportedGates = candidate
					lastReportedPairs = effectivePairs
				}
				if ((elapsed >= WORKER_ROUND_MS || shouldFinishReducedRound(elapsed, nPrevGates, localGates)) && Atomics.load(stopSignal, 0) === 0) {
					Atomics.store(stopSignal, 0, 1)
					logVerbose(`Round time target reached; finishing active jobs and returning queued jobs unchanged.`)
				}
			}
			logVerbose(`Round started: ${nPrevGates} gates across ${jobCount} ${wholeCircuit ? 'whole-circuit searches' : 'chunk jobs'}${runBroad ? ' plus one broad search' : ''} on up to ${nWorkers} workers; summaries every ${config.timing.summarySeconds} seconds`)
			reportStatus = (force = false) => {
				try { report(force) }
				catch (error) { Atomics.store(stopSignal, 0, 1); rejectCheckpoint(error) }
			}
			try {
				const canContinue = () => {
					if (!config.workers.keepBusy || Atomics.load(stopSignal, 0) !== 0) return false
					const count = localCount()
					const elapsed = performance.now() - lastIterationTime
					if (!count || elapsed >= WORKER_ROUND_MS || shouldFinishReducedRound(elapsed, nPrevGates, count)) {
						Atomics.store(stopSignal, 0, 1)
						return false
					}
					return true
				}
				// Each lane starts from the round input and advances only its own
				// candidates. Neither uses the other's results before selection.
				const broad = runBroad ? (async () => {
					do {
						statuses[jobCount] = { updatedAtMs: performance.now() - lastIterationTime, done: false, started: false }
						const accept = (candidate: Gate[], patch?: WorkerActivity['cutPatch']) => {
							if (!isBetterCircuit(candidate, broadBest)) return
							roundPatches?.observe(broadBest, patch)
							broadBest = candidate
							pendingCheckpoint = true
						}
						const jobInput = broadBest
						const result = await pool.run(jobInput, inputCircuit.wire_count, (_, activity, snapshot) => {
							observeStrategy('Global', activity)
							statuses[jobCount] = { activity, updatedAtMs: performance.now() - lastIterationTime, done: false, started: true }
							if (snapshot) accept(snapshot, activity?.cutPatch)
						}, stopSignal.buffer as SharedArrayBuffer, config.workers.jobSeconds * 1000, false, 'broad', optimizerRound, globalStrategy)
						statuses[jobCount].done = true
						accept(result)
						if (statuses[jobCount].activity?.broadExhausted) {
							const key = jobInput === broadInput ? broadKey! : hashGates(jobInput)
							const completed = completedBroadScans.get(key) ?? new Set<string>()
							completed.add(globalStrategy ?? '')
							completedBroadScans.set(key, completed)
							break
						}
						await yieldToCoordinator()
					} while (broadBest.length > 0 && (config.workers.keepBusy
						? canContinue()
						: completed < jobCount && Atomics.load(stopSignal, 0) === 0))
				})().finally(() => pool.setBroadReservation(false)) : Promise.resolve()
				const local = Promise.all(approxGates.map(async (_initial, index) => {
					const workerFile = paths.worker(index)
					let chunk = index
					do {
						if (config.workers.keepBusy && !snapshots[chunk].length) {
							const next = snapshots.findIndex(candidate => candidate.length > 0)
							if (next === -1) { Atomics.store(stopSignal, 0, 1); break }
							chunk = next
						}
						const target = chunk, dataChunk = snapshots[target]
						writeCircuit(workerFile, inputCircuit.wire_count, dataChunk)
						let executionStarted: number | undefined
						const accept = (candidate: Gate[]) => {
							// Several idle lanes may retry the same remaining chunk. Their
							// results are alternatives, never additional chunks to concatenate.
							if (!(splitCost ? splitCost.accept(target, candidate) : isBetterCircuit(candidate, snapshots[target]))) return
							snapshots[target] = candidate; candidateCounts[target] = candidate.length
							pendingCheckpoint = true
						}
						const result = await pool.run(dataChunk, inputCircuit.wire_count, (_count, activity, snapshot) => {
								executionStarted ??= performance.now()
								observeStrategy('Local', activity)
								if (snapshot) {
									try { accept(snapshot) } catch (error) { Atomics.store(stopSignal, 0, 1); rejectCheckpoint(error) }
								}
								statuses[index] = { activity, updatedAtMs: performance.now() - lastIterationTime, done: false, started: true }
						}, stopSignal.buffer as SharedArrayBuffer, config.workers.jobSeconds * 1000, false, 'local', optimizerRound, undefined, !wholeCircuit)
						if (executionStarted !== undefined) {
							const cost = (performance.now() - executionStarted) / Math.max(1, dataChunk.length)
							for (const wire of new Set(dataChunk.flatMap(getVars))) wireCosts.set(wire, ((wireCosts.get(wire) ?? cost) + cost) / 2)
						}
						accept(result)
						completed++
						statuses[index].done = true
						writeCircuit(workerFile, inputCircuit.wire_count, result)
						if (!canContinue()) break
						statuses[index] = { updatedAtMs: performance.now() - lastIterationTime, done: false, started: false }
						await yieldToCoordinator()
					} while (canContinue())
					statuses[index].done = true
					return snapshots[index]
				}))
				await Promise.race([memoryFailure, checkpointFailed, Promise.all([local, broad])])
				const localBest = localCandidate()
				const merged = runBroad && !wholeCircuit && localBest.length < nPrevGates
					? roundPatches?.merge(approxGates, snapshots) ?? mergeDisjointRoundResults(currentGates, approxGates, snapshots, broadBest, (before, after) => {
						if (before.length > config.synthesis.affineMaximumWindowGates) return false
						const wires = mapVariablesToIndexes(before)
						const allowed = new Set(wires)
						if (after.some(gate => getVars(gate).some(wire => !allowed.has(wire)))) return false
						const prove = createPolynomialEquivalenceChecker(mapCircuit(before, wires), wires.length, config.synthesis.affineMaximumTerms, config.synthesis.affineMaximumOperations)
						return prove(mapCircuit(after, wires)) === true
					}) : undefined
				currentGates = roundSearchResult(merged ? [localBest, broadBest, merged] : [localBest, broadBest], true)
				winner = currentGates === merged ? 'combined' : currentGates === localBest ? 'local' : 'global'
				if (isBetterCircuit(bestObserved, currentGates)) {
					currentGates = bestObserved
					winner = bestObservedSide
				}
				if (globalStrategy) globalStrategyPicker.observe(globalStrategy, nPrevGates - broadBest.length)
			} finally {
				clearInterval(checkpointTimer)
				Atomics.store(stopSignal, 0, 1)
				await checkpointFlush
				beginPhase('finishing round')
			}
			const roundElapsedMs = performance.now() - lastIterationTime
			report(false, currentGates, roundElapsedMs)
			const filename = paths.progress(currentGates.length)
			if (!checkpoint.hasSaved) {
				await writer.write([filename, paths.latest], currentGates)
			} else await checkpoint.saveIfReduced(currentGates)
			const gatesRemoved = nPrevGates - currentGates.length
			const endTime = performance.now()
			if (config.workers.adaptiveConcurrency && !config.workers.keepBusy) {
				const resources = statuses.map(status => status.activity?.resources)
				const reason = concurrency.observe({ concurrency: nWorkers, elapsedMs: endTime - lastIterationTime, removed: gatesRemoved, databaseMs: resources.reduce((sum, value) => sum + (value?.databaseMs ?? 0), 0), workerMs: resources.reduce((sum, value) => sum + (value?.elapsedMs ?? 0), 0), memoryPressure: memoryPressure(config.workers.memoryBudgetMegabytes) })
				if (reason === 'memory budget pressure') { pool.setConcurrency(concurrency.limit(nMaxWorkers)); await pool.trimIdle() }
				if (reason) logVerbose(`Next round worker target: ${concurrency.limit(nMaxWorkers)} (${reason})`)
			}
			if (!config.workers.keepBusy && !wholeCircuit && !(runBroad && currentGates.length < nPrevGates)) {
				beginPhase('shuffling next round')
				currentGates = await pool.run(currentGates, inputCircuit.wire_count, undefined, undefined, config.workers.jobSeconds * 1000, false, 'shuffle')
			}
			const localRemoved = nPrevGates - localCount()
			const globalReduction = runBroad ? ` | Global: ${nPrevGates - broadBest.length} gates removed` : ''
			const gatesPerHour = roundElapsedMs > 0 ? Math.floor(gatesRemoved * 3_600_000 / roundElapsedMs) : 0
			const combinedReduction = winner === 'combined' ? ` | Combined: ${gatesRemoved} gates removed` : ''
			logTimed(`Round winner: ${winner} | Local: ${localRemoved} gates removed${globalReduction}${combinedReduction} | Result: ${formatCircuitSize(currentGates.length, circuitWireCost(currentGates).effectivePairs)} | ${gatesPerHour} gates/hour`)
			for (const side of ['Local', 'Global'] as const) {
				const counts = formatRoundStrategies(roundStrategies[side].values(), side)
				if (counts) logTimed(counts)
			}
		}
	} finally {
		clearInterval(memoryTimer)
		clearInterval(summaryTimer)
		await pool.close()
		await writer.close()
	}
}
