import { CheckpointWriter } from './checkpoint-writer.js'
import { opaqueRainbow } from './opaque-rainbow.js'
import { AdaptiveStrategyPicker } from './strategy-picker.js'
import { searchDependencyCuts } from './dependency-cuts.js'
import { setImmediate as yieldToCoordinator, setTimeout as waitForWork } from 'node:timers/promises'
import { createPolynomialEquivalenceChecker } from './symbolic-affine.js'
import { structuralChoices, structuralNames, structuralRewrite, StructuralStrategy } from './structural-strategies.js'
import { PeriodicStrategy, WholeCircuitRestart, roundSearchPlan, roundSearchResult } from './round-search.js'
import { StrategySummary, StrategyWeightSummary, formatStrategyActivity } from './logging.js'
import { recordStrategy, resetStrategyStats, strategySnapshot } from './strategy-stats.js'
import { selectIntervals } from './intervals.js'
import { AdaptiveConcurrency, MemoryConcurrency, memoryPressure, memorySnapshot } from './concurrency.js'
import { lookupDatabaseTime } from './lookup-statements.js'
import { loadSharedTables } from './shared-table.js'
import { ChunkedSequence } from './chunked-sequence.js'
import { SlidingWindowWires } from './window-wires.js'
import { LazyCircuit } from './circuit-edit.js'
import { IncrementalGraph } from './incremental-graph.js'
import { WindowFingerprints } from './fingerprints.js'
import { templates, advancedRewrite, wholeCircuitAffineSearch, SynthesisBudget } from './strategies.js'
import { IncrementalEvaluator } from './packed.js'
import { RewriteCache, SearchScheduler, balancedChunks, improving, SearchArm, NeighborhoodQueue, createSearchArms, independentComponents } from './search.js'
import { config, minimumBroadGates } from './config.js'
import { formatCoordinatorPhase, SummaryThrottle, verboseLogging, formatProgress, formatWorkerActivity, formatStatus, WorkerActivity, WorkerStatus, shouldFinishReducedRound, logVerbose } from './logging.js'
import { areBooleanArraysEqual, calculateAllOutputsArray, chunkArray, dependencyGraphToMap, dependencySort, evalCircuit, findConvexSubsets, generateCombinations, generateNRandomBooleanArray, getRandomNumberInRange, getVars, hashGates, ioHash, isReplacementSimpler, logTimed, mapCircuit, mapVariablesToIndexes, randomOrder, replace, reverseMapCircuit, simplifyGate, verifyCircuit } from './utils.js'
import { Gate } from './types.js'
import { RainbowPortfolio, RainbowMatch } from './rainbow-portfolio.js'
import { LimitedMap } from './limitedMap.js'
import { WorkerPool, configuredWorkerCount } from './threads.js'
import { createDependencyGraph } from './lineswapper.js'
import { outputPaths, prepareOutputDirectories, writeCircuit, writeCircuitCopies, AsyncReductionCheckpoint } from './storage.js'
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
const findProbabilisticUselessVars = (variableIndexMapping: number[], mappedGates: Gate[], shouldStop: () => boolean = () => false) => {
	if (shouldStop()) return undefined
	const nVariables = variableIndexMapping.length
	const cachedOutputs: boolean[][] = []
	const canImprove = improving(mappedGates)
	if (nVariables < MAX_DETERMINISTIC_USELESS_VARS) return undefined // no need to do this approach for less than 8 vars as we have exact way already
	const proveEquivalent = createPolynomialEquivalenceChecker(mappedGates, nVariables, config.synthesis.affineMaximumTerms, config.synthesis.affineMaximumOperations, shouldStop)
	const accepted = (candidate: Gate[]) => areCircuitsProbabilisticallyTheSame(cachedOutputs, mappedGates, candidate, INPUTS, nVariables) && proveEquivalent(candidate) === true
	if (accepted([])) return []
	
	const combined = combineGates(mappedGates, shouldStop)
	if (combined.combined) {
		if (canImprove(combined.gates) && accepted(combined.gates)) {
			return reverseMapCircuit(combined.gates, variableIndexMapping)
		}
	}
	
	for (let variableIndex = 0; variableIndex < nVariables; variableIndex++) {
		if (shouldStop()) return undefined
		const newRemovedCircuit = removeVariable(mappedGates, variableIndex)
		if (canImprove(newRemovedCircuit) && accepted(newRemovedCircuit)) {
			return reverseMapCircuit(newRemovedCircuit, variableIndexMapping)
		}
		const hasVariableIndexAsNontarget = mappedGates.find((x) => {
			const vars = getVars(x)
			return vars.slice(1).includes(variableIndex)
		}) !== undefined
		if (hasVariableIndexAsNontarget) {
			const newRemovedCircuitNontarget = removeNonTargetVariable(mappedGates, variableIndex)
			if (canImprove(newRemovedCircuitNontarget) && accepted(newRemovedCircuitNontarget)) {
				return reverseMapCircuit(newRemovedCircuitNontarget, variableIndexMapping)
			}
		}
		for (let newVar = 0; newVar < nVariables; newVar++) {
			if (shouldStop()) return undefined
			if (variableIndexMapping[variableIndex] <= variableIndexMapping[newVar]) continue
			const newCircuit = mappedGates.map((gate) => replaceVar(gate, variableIndex, newVar))
			if (canImprove(newCircuit) && accepted(newCircuit)) {
				return reverseMapCircuit(newCircuit, variableIndexMapping)
			}
			
			if (hasVariableIndexAsNontarget) {
				const newCircuit2 = mappedGates.map((gate) => replaceNonTargetVar(gate, variableIndex, newVar))
				if (canImprove(newCircuit2) && accepted(newCircuit2)) {
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
	if (result !== undefined && config.synthesis.templates) templates.learn(gates, result)
	return result === undefined ? undefined : reverseMapCircuit(result, mapping)
}


/** Reused only while the subset and its template revision remain unchanged. */
export class SubsetPreparation {
	private revision = -1
	private templated?: Gate[]
	private fingerprints = new WeakMap<Gate[], WindowFingerprints>()
	constructor(readonly gates: Gate[]) {}
	templateGates() {
		const revision = config.synthesis.templates ? templates.version : -2
		if (!this.templated || revision !== this.revision) {
			this.templated = config.synthesis.templates ? templates.rewrite(this.gates) : this.gates
			this.revision = revision
		}
		return this.templated
	}
	fingerprint(gates: Gate[]) {
		let value = this.fingerprints.get(gates)
		if (!value) { value = new WindowFingerprints(gates); this.fingerprints.set(gates, value) }
		return value
	}
}

type PreparedWindow = { variableIndexMapping: number[], mappedGates: Gate[] }

const optimizeVariables = (processedGatesCache: LimitedMap<string, boolean>, gates: Gate[], sliceSize: number, useProbabilistically: boolean, findUselessVarsSetting: boolean, rainbowTableWires: number, prepared: Map<number, PreparedWindow>, preparation: SubsetPreparation, shouldStop: () => boolean = () => false): { gates: Gate[], changed: boolean } => {
	const replacements: { start: number, end: number, replacement: Gate[] }[] = []
	const fingerprints = preparation.fingerprint(gates)
	let nextStart = 0
	let preparedRows = 0
	let uselessVarsFound = 0
	let uselessVarsFoundProb = 0
	if (sliceSize <= 2 || !findUselessVarsSetting) return { gates, changed: false }
	for (const window = new SlidingWindowWires(gates, sliceSize); window.next();) {
		if (shouldStop()) break
		const { start, end } = window
		if (start < nextStart) continue
		if (fingerprints.seen(processedGatesCache, start, end)) continue
		const sliceGates = gates.slice(start, end)

		const variableIndexMapping = window.mapping() // counts are maintained across adjacent windows
		const mappedGates = mapCircuit(sliceGates, variableIndexMapping)
		if (preparedRows + mappedGates.length <= 100_000) { prepared.set(start, { variableIndexMapping, mappedGates }); preparedRows += mappedGates.length }
		const replacement = findUselessVars(variableIndexMapping, mappedGates, shouldStop)
		if (replacement !== undefined) {
			replacements.push({ start, end: end - 1, replacement: gateSimplifier(replacement) })
			uselessVarsFound++
			nextStart = end
			continue
		}
		if (useProbabilistically) {
			const replacement = findProbabilisticUselessVars(variableIndexMapping, mappedGates, shouldStop)
			if (replacement !== undefined) {
				replacements.push({ start, end: end - 1, replacement: gateSimplifier(replacement) })
				uselessVarsFoundProb++
				nextStart = end
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

const adaptiveFailureCaches = new WeakMap<AdaptiveStrategyPicker, Map<string, LimitedMap<string, boolean>>>()
const dependencySearches = new WeakMap<object, { picker: AdaptiveStrategyPicker, processed: LimitedMap<string, boolean>, offset: number }>()

export const massOptimizeStep = async (tables: RainbowPortfolio, ioIdentifierCache: LimitedMap<string, Gate[] | null>, processedGatesCache: LimitedMap<string, boolean>, originalGates: Gate[], sliceSize: number, useProbabilistically: boolean, findUselessVarsSetting: boolean, lookup = true, preparation = new SubsetPreparation(originalGates), synthesisBudget?: SynthesisBudget, strategyPicker?: AdaptiveStrategyPicker): Promise<{ gates: Gate[], changed: boolean }> => {
	const attemptStarted = performance.now()
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
		...(!wideOnly && config.synthesis.templates ? [{ name: 'templates' }] : []),
		...(findUselessVarsSetting && sliceSize > 2 ? [{ name: 'variables' }] : []),
		...(lookup ? [{ name: 'rainbow' }] : []),
		...synthesisNames.map(name => ({ name })),
		...(synthesisBudget?.broad && (config.synthesis.affine || config.synthesis.quadratic) ? [{ name: 'symbolic' }] : []),
	]
	const selected = synthesisBudget?.selectedStrategy ?? (config.search.strategyAdaptive || synthesisBudget?.dependencyRegion ? strategyPicker?.pick(available)?.name : undefined)
	if (strategyPicker && config.search.strategyAdaptive && !selected) return { gates: originalGates, changed: false }
	const runTemplates = !wideOnly && (selected === undefined || selected === 'templates')
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
		if (result.changed && config.synthesis.templates) templates.learn(originalGates, result.gates)
		if (selected) strategyPicker?.observe(selected, originalGates.length - result.gates.length, performance.now() - attemptStarted)
		return result
	}
	if (selected === 'dependency-cuts') {
		const key = strategyPicker ?? ioIdentifierCache
		let state = dependencySearches.get(key)
		if (!state) {
			state = { picker: new AdaptiveStrategyPicker(['rainbow', 'templates', 'variables', ...structuralNames, 'symbolic', 'gf2-affine', 'quadratic', 'forward-semantic-search', 'z3', 'meet-in-the-middle', 'equality-saturation'], pickerOptions), processed: new LimitedMap(config.cache.processedEntries), offset: 0 }
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
			const next = await massOptimizeStep(tables, ioIdentifierCache, state!.processed, cut.gates, cut.gates.length, useProbabilistically, config.search.variableElimination, true, new SubsetPreparation(cut.gates), { deadline, shouldStop: stopped, broad: true, minimumBroadGates: broadMinimum, dependencyRegion: true }, state!.picker)
			return next.changed ? next.gates : undefined
		}, state.offset++, stats, state, broadMinimum)
		// Toolkit calls have their own timings; count only cut-index overhead here.
		recordStrategy('dependency-cuts', { global: true }, attemptStarted + stats.solverMs, originalGates.length, result?.length ?? originalGates.length, result !== undefined)
		return finish({ gates: result ?? originalGates, changed: result !== undefined })
	}
	if (selected === 'rainbow' && synthesisBudget?.dependencyRegion) {
		const result = await opaqueRainbow(originalGates, tables, ioIdentifierCache, () => performance.now() >= synthesisBudget.deadline || synthesisBudget.shouldStop?.() === true)
		if (result) { recordStrategy('rainbow', { opaque: true }, attemptStarted, originalGates.length, result.length, true); return finish({gates: result, changed:true}) }
	}
	if (selected === 'symbolic') {
		const result = wholeCircuitAffineSearch(originalGates, Math.max(0, (synthesisBudget?.deadline ?? performance.now()) - performance.now()), () => synthesisBudget?.shouldStop?.() === true)
		return finish({ gates: result, changed: result !== originalGates })
	}
	if (selected && (structuralNames as readonly string[]).includes(selected)) {
		const result = await structuralRewrite(selected as StructuralStrategy, originalGates, synthesisBudget?.deadline ?? performance.now() + config.workers.jobSeconds * 1000, () => synthesisBudget?.shouldStop?.() === true)
		return finish({ gates: result ?? originalGates, changed: result !== undefined })
	}
	const prepared = new Map<number, PreparedWindow>()
	if (preparation.gates !== originalGates) throw new Error('Subset preparation belongs to a different circuit')
	let strategyStarted = performance.now()
	const templateResult = runTemplates ? preparation.templateGates() : originalGates
	if (config.synthesis.templates && runTemplates) recordStrategy('templates', { maximumWires: config.synthesis.maximumWires, maximumWindowGates: config.synthesis.maximumWindowGates }, strategyStarted, originalGates.length, templateResult.length, templateResult !== originalGates)
	strategyStarted = performance.now()
	const changes = optimizeVariables(processedGatesCache, templateResult, sliceSize, useProbabilistically, findUselessVarsSetting, lookup ? tables.maximumWires : 0, prepared, preparation, () => synthesisBudget?.shouldStop?.() === true || (synthesisBudget !== undefined && performance.now() >= synthesisBudget.deadline))
	if (findUselessVarsSetting && sliceSize > 2) recordStrategy('variables', { slice: sliceSize, probabilistic: useProbabilistically, exactMaximumWires: config.search.exactMaximumWires }, strategyStarted, templateResult.length, changes.gates.length, changes.changed)
	changes.changed ||= templateResult !== originalGates
	if (!lookup) {
		if (runSynthesis && !changes.changed) { const candidate = await advancedRewrite(originalGates, selectedBudget); if (candidate) return finish({ gates: candidate, changed: true }) }
		return finish(changes)
	}
	const gates = changes.gates
	const fingerprints = preparation.fingerprint(gates)
	const queries: { start: number, end: number, variableIndexMapping: number[], mappedGates: Gate[] }[] = []
	const replacements: { start: number, end: number, replacement: Gate[] }[] = []

	const candidates: { start: number, end: number, variableIndexMapping: number[], mappedCount: number, templateBefore?: Gate[], match: RainbowMatch, removed: number, wireSavings: number, readSavings: number }[] = []
	let queryRows = 0
	strategyStarted = performance.now()
	const flushQueries = async () => {
		const matches = await tables.findReplacements(queries.map(query => ({ mappedGates: query.mappedGates, wires: query.variableIndexMapping.length })), ioIdentifierCache)
		for (const [index, query] of queries.entries()) {
			const match = matches.get(index)
			if (!match) { fingerprints.remember(processedGatesCache, query.start, query.end); continue }
			const oldVariables = query.mappedGates.flatMap(getVars), newVariables = match.gates.flatMap(getVars)
			candidates.push({ start: query.start, end: query.end, variableIndexMapping: query.variableIndexMapping, mappedCount: query.mappedGates.length, templateBefore: query.mappedGates.length <= config.synthesis.maximumWindowGates ? query.mappedGates : undefined, match, removed: query.mappedGates.length - match.gates.length, wireSavings: new Set(oldVariables).size - new Set(newVariables).size, readSavings: oldVariables.length - newVariables.length })
		}
		queries.length = 0; queryRows = 0
	}
	for (const window = new SlidingWindowWires(gates, sliceSize); window.next();) {
		if (synthesisBudget?.shouldStop?.() || (synthesisBudget && performance.now() >= synthesisBudget.deadline)) break
		const { start, end } = window
		if (end - start < (broadMinimum ?? 0) || window.wireCount > tables.maximumWires) continue
		if (fingerprints.seen(processedGatesCache, start, end)) continue
		// Window positions remain valid only when the variable pass made no changes.
		const cached = changes.changed ? undefined : prepared.get(start)
		const sliceGates = cached ? [] : gates.slice(start, end)
		const variableIndexMapping = cached?.variableIndexMapping ?? window.mapping()
		if (variableIndexMapping.length <= tables.maximumWires) {
			const mappedGates = cached?.mappedGates ?? mapCircuit(sliceGates, variableIndexMapping)
			queries.push({ start, end, variableIndexMapping, mappedGates })
			queryRows += mappedGates.length
			if (queryRows >= 100_000 || queries.length >= config.database.queryBatchSize) await flushQueries()
		}
	}
	if (queries.length) await flushQueries()
	for (const query of selectIntervals(candidates)) {
		tables.recordApplied(query.match, query.mappedCount)
		if (config.synthesis.templates && query.templateBefore) templates.learn(query.templateBefore, query.match.gates)
		replacements.push({ start: query.start, end: query.end - 1, replacement: reverseMapCircuit(query.match.gates, query.variableIndexMapping) })
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
			if (shouldStop()) return
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

export const optimizeSubset = async (tables: RainbowPortfolio, slicedVersion: Gate[], ioIdentifierCache: LimitedMap<string, Gate[] | null>, processedGatesCache: LimitedMap<string, boolean>, subsetSize: number, maxSlice: number, phase: 'simplest' | 'heavy', timeToEndWorker: () => boolean, activity: WorkerActivity, onCandidate: (gates: Gate[]) => void, testedSubsets: LimitedMap<string, boolean>, method: SearchArm['method'], onLazyCandidate?: (gates: ChunkedSequence<Gate>) => void, synthesisBudget?: SynthesisBudget, strategyPicker?: AdaptiveStrategyPicker): Promise<Gate[]> => {
	const useProbabilistically = method !== 'rainbow' && phase === 'heavy' && config.search.probabilistic
	const findUselessVarsSetting = method !== 'rainbow' && config.search.variableElimination
	let regenerateGraph = false
	let changedWires = new Set<number>()
	const neighborhoods = new NeighborhoodQueue(config.search.localSearchSeeds, config.search.localSearchRadius, config.search.localSearchBroadEvery)
	const circuit = new ChunkedSequence(slicedVersion, config.search.circuitChunkGates)
	activity.stage = 'preparing'
	if (timeToEndWorker()) return circuit.toArray()
	const graph = config.search.incrementalDependencies ? new IncrementalGraph(slicedVersion, config.search.circuitChunkGates) : undefined
	do {
		activity.stage = 'preparing'
		let graphIterator = findConvexSubsets(subsetSize, circuit, config.search.prioritizeChangedWires ? changedWires : undefined, graph?.context(), config.search.localSearch ? neighborhoods.take() : [], () => { activity.stage = 'preparing'; return timeToEndWorker() })
		regenerateGraph = false
		for (let lines of graphIterator) {
			activity.stage = 'searching'
			const subsetKey = `${config.synthesis.templates ? templates.version : 0}:${maxSlice}:${method}:${hashGates(lines.map(line => circuit.at(line)))}`
			if (!(config.search.strategyAdaptive && strategyPicker) && testedSubsets.has(subsetKey)) continue
			let subsetChanged = false
			activity.subsets++
			while (lines.length) {
				const inGates = lines.map(line => circuit.at(line))
				const preparation = new SubsetPreparation(inGates)
				let changed = false
				for (let slice = config.search.sliceMinimum; slice <= Math.min(maxSlice, lines.length); slice++) {
					if (timeToEndWorker()) return circuit.toArray()
					activity.checks++
					const optimizationOutput = await massOptimizeStep(tables, ioIdentifierCache, processedGatesCache, inGates, slice, useProbabilistically, findUselessVarsSetting, method !== 'variables', preparation, synthesisBudget, strategyPicker)
					if (!optimizationOutput.changed) continue
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
			if (!subsetChanged && !(config.search.strategyAdaptive && strategyPicker)) testedSubsets.set(subsetKey, true)
			if (regenerateGraph) {
				break
			}
		}
	} while(regenerateGraph)
	return circuit.toArray()
}

const pickerOptions = () => ({ enabled: config.search.strategyAdaptive, exploration: config.search.strategyExplorationProbability, specialize: config.search.strategySpecialization, halfLifeSeconds: config.search.strategyDecayHalfLifeSeconds })
export const createOptimizerCaches = () => ({
	strategyPicker: new AdaptiveStrategyPicker(['templates', 'variables', 'rainbow', 'gf2-affine', 'quadratic', ...structuralNames, 'forward-semantic-search', 'z3', 'meet-in-the-middle', 'equality-saturation'], pickerOptions),
	broadStrategyPicker: new AdaptiveStrategyPicker([...structuralNames, 'dependency-cuts', 'symbolic', 'variables', 'rainbow'], pickerOptions),
	ioIdentifierCache: new LimitedMap<string, Gate[] | null>(config.cache.lookupEntries, config.cache.lookupPolicy),
	processedGatesCache: new LimitedMap<string, boolean>(config.cache.processedEntries),
	arms: createSearchArms(config.search.searchArms, config.search.subsetMinimum, config.search.subsetMaximum, config.search.sliceMinimum, config.search.sliceMaximum),
	scheduler: new SearchScheduler(config.search.explorationEvery, config.search.schedulerDecay, config.search.schedulerHistoryEntries),
	testedSubsets: new LimitedMap<string, boolean>(config.cache.subsetEntries),
	methodCaches: new Map<string, LimitedMap<string, boolean>>(),
})

export const optimize = async (tables: RainbowPortfolio, originalGates: Gate[], wires: number, problemName: string, workerMode: boolean, caches = createOptimizerCaches(), roundDurationMs = WORKER_ROUND_MS, onProgress?: (gates: number, activity: WorkerActivity, snapshot?: Gate[]) => void, shouldFinish?: (activity?: WorkerActivity) => boolean, wantsSnapshot?: (gates: number) => boolean, reportOnImprovement = false) => {
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
	let subsetSize = getRandomNumberInRange(config.search.subsetMinimum, config.search.subsetMaximum + 1)
	let maxSlice = getRandomNumberInRange(config.search.sliceMinimum, config.search.sliceMaximum + 1)
	let phase: 'simplest' | 'heavy' = 'heavy'
	const arms = !config.search.adaptive ? [] : config.search.stableSearchArms ? caches.arms : createSearchArms(config.search.searchArms, config.search.subsetMinimum, config.search.subsetMaximum, config.search.sliceMinimum, config.search.sliceMaximum).map(arm => ({ ...arm, subset: getRandomNumberInRange(config.search.subsetMinimum, config.search.subsetMaximum + 1), slice: getRandomNumberInRange(config.search.sliceMinimum, config.search.sliceMaximum + 1) }))
	//logTimed(`optimizer started with subset ${subsetSize}`)
	const activity: WorkerActivity = { passes: 0, subsets: 0, checks: 0, improvements: 0, stage: 'searching' }
	const progressActivity = (): WorkerActivity => ({ ...activity, strategyWeights: config.search.strategyAdaptive ? caches.strategyPicker.weights() : undefined, strategies: strategySnapshot(), rainbowTables: tables.statistics(), resources: { databaseMs: lookupDatabaseTime() - databaseStarted, elapsedMs: performance.now() - jobStarted, heapUsedBytes: process.memoryUsage().heapUsed } })
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
		if (onProgress && ((reportOnImprovement && !publishedReduction && wantsSnapshot?.(candidateParts.length)) || endTime - lastProgress >= config.timing.workerReportSeconds * 1000)) {
			onProgress(candidateParts.length, progressActivity(), wantsSnapshot && !wantsSnapshot(candidateParts.length) ? undefined : candidateParts.materialize())
			lastProgress = endTime
			if (wantsSnapshot?.(candidateParts.length)) publishedReduction = true
		}
		return shouldFinish?.(activity) === true || endTime >= jobDeadline
	}
	const heartbeat = onProgress ? setInterval(() => {
		const improved = wantsSnapshot?.(candidateParts.length)
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
		const components = config.search.independentComponents ? independentComponents(optimizedVersion) : [optimizedVersion]
		const chunked = components.flatMap(component => chunkArray(component, Math.max(1, Math.min(component.length, Math.floor(nChunks / components.length)))))
		candidateParts = new LazyCircuit(chunked)
		await Promise.all(chunked.map(async (data, index) => {
			const result = await optimizeSubset(tables, data, ioIdentifierCache, methodCache!, subsetSize, maxSlice, phase, timeToEndWorker, activity, () => {}, caches.testedSubsets, method, gates => {
				candidateParts.update(index, gates)
				timeToEndWorker()
			}, { deadline: jobDeadline, shouldStop: () => shouldFinish?.(activity) === true }, caches.strategyPicker)
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

export const splitTaskAndRun = async (pathToFileWithoutExt: string, original: string, circuits: JobCircuits = loadJob(pathToFileWithoutExt, original), onPhase: (phase: string) => void = () => {}) => {
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
	try { await writer.write([outputPaths(pathToFileWithoutExt).latest], gates) } catch (error) { await writer.close(); throw error }
	if (!gates.length) { await writer.close(); return }
	const nMaxWorkers = configuredWorkerCount()
	onPhase('loading shared rainbow table snapshots')
	const sharedTables = await loadSharedTables()
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
	let savedGateCount: number | undefined
	const strategySummary = new StrategySummary()
	const strategyWeights = new StrategyWeightSummary()
	let nextStrategyJob = 0
	let lastImprovementTime = performance.now()
	const broadSchedule = new PeriodicStrategy(config.workers.broadSearchSeconds * 1000)
	const summaryThrottle = new SummaryThrottle(config.timing.summarySeconds * 1000)
	let reportStatus: (force?: boolean) => void = () => {}
	const beginPhase = (phase: string) => {
		const started = performance.now()
		reportStatus = (force = false) => {
			if (!summaryThrottle.allow(performance.now(), force || verboseLogging())) return
			logTimed(formatCoordinatorPhase(currentGates.length, originalGates.length, savedGateCount, phase, performance.now() - started))
			if (!verboseLogging()) {
				const summary = strategySummary.flush()
				if (summary) logTimed(summary)
			}
			for (const weights of strategyWeights.format()) logTimed(weights)
		}
	}
	beginPhase('preparing next round')
	// One timer for the entire run; it is never reset at round boundaries.
	const summaryTimer = setInterval(() => reportStatus(true), config.timing.summarySeconds * 1000)
	const memoryTimer = setInterval(monitorMemory, 500)
	try {
		while(currentGates.length > 0) {
			onPhase('running optimizer searches')
			beginPhase('preparing next round')
			currentGates = gateSimplifier(currentGates)
			let lastIterationTime = performance.now()
			const nPrevGates = currentGates.length
			const workersSize = getRandomNumberInRange(Math.min(config.workers.minimumChunkGates, currentGates.length), Math.max(1, currentGates.length * config.workers.maximumChunkFraction))
			const runBroad = currentGates.length >= minimumBroadGates() && (config.workers.keepBusy ? config.workers.broadSearchSeconds > 0 : broadSchedule.take(performance.now()))
			let broadStarted = false
			const plan = roundSearchPlan(currentGates.length, nMaxWorkers, workersSize, config.workers.wholeCircuitMaximumGates)
			const wholeCircuit = plan.wholeCircuit || (config.workers.keepBusy && currentGates.length < nMaxWorkers)
			requestedConcurrency = config.workers.keepBusy ? nMaxWorkers : config.workers.adaptiveConcurrency ? concurrency.limit(Math.min(nMaxWorkers, plan.capacity + Number(runBroad))) : Math.min(nMaxWorkers, plan.capacity + Number(runBroad))
			const nWorkers = memoryLimit.limit(requestedConcurrency)
			activeConcurrency = nWorkers
			pool.setConcurrency(nWorkers)
			// Queue enough independent lanes for the requested capacity so staged
			// startup can fill newly available slots within this same round.
			const queueCapacity = config.workers.keepBusy ? requestedConcurrency : nWorkers
			const localWorkers = Math.max(1, queueCapacity - Number(runBroad && queueCapacity > 1))
			const requestedJobs = config.workers.keepBusy ? Math.max(nWorkers, localWorkers * config.workers.jobsPerWorker) : localWorkers * config.workers.jobsPerWorker
			const jobCount = wholeCircuit ? requestedJobs : Math.min(currentGates.length, requestedJobs)
			const approxGates = wholeCircuit ? Array.from({ length: jobCount }, () => currentGates.slice()) : config.search.balancedWorkers ? balancedChunks(currentGates, jobCount, wireCosts) : splitArrayIntoApproximatelyChunks(currentGates, jobCount)
			const candidateCounts = approxGates.map(chunk => chunk.length)
			const snapshots = approxGates.slice()
			const stopSignal = new Int32Array(new SharedArrayBuffer(4))
			let broadStop: Int32Array | undefined
			const checkpoint = new AsyncReductionCheckpoint(nPrevGates, async snapshot => {
				await writer.write([paths.progress(snapshot.length), paths.latest], snapshot)
				savedGateCount = snapshot.length
			})
			const restart = wholeCircuit || runBroad ? new WholeCircuitRestart(currentGates, stopSignal, candidate => {
				logVerbose(`New best checkpoint: ${candidate.length} gates.`)
			}) : undefined
			let rejectCheckpoint!: (error: unknown) => void
			const checkpointFailed = new Promise<never>((_, reject) => { rejectCheckpoint = reject })
			let completed = 0
			const statuses: WorkerStatus[] = Array.from({ length: jobCount + Number(runBroad) }, () => ({ updatedAtMs: 0, done: false, started: false }))
			const localCandidate = () => roundSearchResult(snapshots, wholeCircuit)
			let pendingLocal = false
			let localFlush: Promise<void> | undefined
			const flushLocal = async (): Promise<void> => {
				if (localFlush) return localFlush
				if (!pendingLocal) return
				const assembled = localCandidate()
				pendingLocal = false
				localFlush = (async () => {
					await checkpoint.saveIfReduced(assembled)
					restart?.accept(assembled, false)
				})()
				try { await localFlush } finally { localFlush = undefined }
			}
			let globalActions: Promise<unknown> = Promise.resolve()
			const acceptGlobal = async (candidate: Gate[]) => {
				await flushLocal()
				// Local work can improve while verification is running. Save and
				// compare the newest assembly before authorizing a global restart.
				const localBest = localCandidate()
				if (candidate.length >= localBest.length || candidate.length >= restart!.best.length) return
				await checkpoint.saveIfReduced(candidate)
				if (candidate.length >= localCandidate().length) return
				if (restart!.accept(candidate)) lastImprovementTime = performance.now()
			}
			const checkpointTimer = setInterval(() => {
				void flushLocal().catch(error => { Atomics.store(stopSignal, 0, 1); rejectCheckpoint(error) })
			}, config.timing.checkpointSeconds * 1000)
			const report = (force = false) => {
				const elapsed = performance.now() - lastIterationTime
				if (config.workers.keepBusy) logVerbose(`Jobs finished this round: ${completed}; continuing searches across ${jobCount} ${wholeCircuit ? 'whole-circuit alternatives' : 'chunks'}.`)
				else logVerbose(formatProgress(nPrevGates, (wholeCircuit ? Math.min(...candidateCounts) : candidateCounts.reduce((sum, count) => sum + count, 0)), completed, jobCount, elapsed))
				logVerbose(formatWorkerActivity(statuses, elapsed, WORKER_ROUND_MS))
				const snapshot = restart ? roundSearchResult([restart.best, localCandidate()], true) : localCandidate()
				if (verboseLogging()) logVerbose(formatStrategyActivity(statuses))
				if (summaryThrottle.allow(performance.now(), force || verboseLogging() || snapshot.length === 0)) {
					logTimed(formatStatus({ original: originalGates.length, roundStart: nPrevGates, candidate: snapshot.length, saved: savedGateCount, statuses, elapsedMs: elapsed }))
					if (!verboseLogging()) {
						const summary = strategySummary.flush()
						if (summary) logTimed(summary)
					}
					for (const weights of strategyWeights.format()) logTimed(weights)
				}
				if ((elapsed >= WORKER_ROUND_MS || shouldFinishReducedRound(elapsed, nPrevGates, snapshot.length)) && Atomics.load(stopSignal, 0) === 0) {
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
					if (!config.workers.keepBusy || Atomics.load(stopSignal, 0) !== 0) { if (broadStop) Atomics.store(broadStop, 0, 1); return false }
					const count = wholeCircuit ? Math.min(...candidateCounts) : candidateCounts.reduce((sum, value) => sum + value, 0)
					const elapsed = performance.now() - lastIterationTime
					if (!count || elapsed >= WORKER_ROUND_MS || shouldFinishReducedRound(elapsed, nPrevGates, count)) { Atomics.store(stopSignal, 0, 1); if (broadStop) Atomics.store(broadStop, 0, 1); return false }
					return true
				}
				// Broad work has priority in the pool, and can recur during long
				// rounds. Local jobs fill its slot while it waits for its cadence.
				const broad = runBroad ? (async () => {
					let best = currentGates
					if (!config.workers.keepBusy && performance.now() - lastImprovementTime < config.workers.broadSearchIdleSeconds * 1000) return best
					do {
						if (config.workers.keepBusy) {
							while (canContinue() && (performance.now() - lastImprovementTime < config.workers.broadSearchIdleSeconds * 1000 || !broadSchedule.take(performance.now()))) await waitForWork(Math.min(250, config.workers.broadSearchSeconds * 1000))
							if (!canContinue()) break
						}
						if (pendingLocal || localFlush) await flushLocal()
						broadStop = new Int32Array(new SharedArrayBuffer(4))
						const jobStop = broadStop
						const broadJob = nextStrategyJob++
						statuses[jobCount] = { updatedAtMs: performance.now() - lastIterationTime, done: false, started: false }
						broadStarted = true
						const result = await pool.run(roundSearchResult([restart!.best, localCandidate()], true), inputCircuit.wire_count, (_, activity, snapshot) => {
							strategySummary.observe(broadJob, activity?.strategies)
							strategyWeights.observe(activity)
							statuses[jobCount] = { activity, updatedAtMs: performance.now() - lastIterationTime, done: false, started: true }
							if (snapshot) {
								globalActions = globalActions.then(() => acceptGlobal(snapshot))
								void globalActions.catch(error => { Atomics.store(stopSignal, 0, 1); rejectCheckpoint(error) })
							}
						}, jobStop.buffer as SharedArrayBuffer, config.workers.jobSeconds * 1000, true, 'broad')
						strategySummary.finish(broadJob); statuses[jobCount].done = true
						await flushLocal()
						await globalActions
						await acceptGlobal(result)
						best = roundSearchResult([best, result], true)
						if (!canContinue()) break
					} while (canContinue())
					return best
				})() : Promise.resolve(currentGates)
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
						const strategyJob = nextStrategyJob++
						const accept = (candidate: Gate[]) => {
							// Several idle lanes may retry the same remaining chunk. Their
							// results are alternatives, never additional chunks to concatenate.
							if (!isReplacementSimpler(candidate, snapshots[target])) return
							snapshots[target] = candidate; candidateCounts[target] = candidate.length
							pendingLocal = true
							lastImprovementTime = performance.now()
							if (broadStop) Atomics.store(broadStop, 0, 1)
							broadSchedule.retry()
						}
						const result = await pool.run(dataChunk, inputCircuit.wire_count, (_count, activity, snapshot) => {
								executionStarted ??= performance.now()
								strategySummary.observe(strategyJob, activity?.strategies)
								strategyWeights.observe(activity)
								if (snapshot) {
									try { accept(snapshot) } catch (error) { Atomics.store(stopSignal, 0, 1); rejectCheckpoint(error) }
								}
								statuses[index] = { activity, updatedAtMs: performance.now() - lastIterationTime, done: false, started: true }
							}, stopSignal.buffer as SharedArrayBuffer, config.workers.jobSeconds * 1000, false)
						strategySummary.finish(strategyJob)
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
				const results = await Promise.race([memoryFailure, checkpointFailed, Promise.all([local, broad])])
				currentGates = roundSearchResult(snapshots, wholeCircuit)
				if (runBroad) currentGates = roundSearchResult([currentGates, results[1]], true)
				if (restart) currentGates = roundSearchResult([restart.best, currentGates], true)
			} finally { clearInterval(checkpointTimer); await localFlush; await globalActions; Atomics.store(stopSignal, 0, 1); if (broadStop) Atomics.store(broadStop, 0, 1); beginPhase('finishing round') }
			if (broadStarted && currentGates.length < nPrevGates) broadSchedule.retry()
			report()
			const filename = paths.progress(currentGates.length)
			if (!checkpoint.hasSaved) {
				await writer.write([filename, paths.latest], currentGates)
				savedGateCount = currentGates.length
			} else await checkpoint.saveIfReduced(currentGates)
			const gatesRemoved = nPrevGates - currentGates.length
			const endTime = performance.now()
			const timeDiffMins = (endTime - lastIterationTime) / 60000
			if (config.workers.adaptiveConcurrency && !config.workers.keepBusy) {
				const resources = statuses.map(status => status.activity?.resources)
				const reason = concurrency.observe({ concurrency: nWorkers, elapsedMs: endTime - lastIterationTime, removed: gatesRemoved, databaseMs: resources.reduce((sum, value) => sum + (value?.databaseMs ?? 0), 0), workerMs: resources.reduce((sum, value) => sum + (value?.elapsedMs ?? 0), 0), memoryPressure: memoryPressure(config.workers.memoryBudgetMegabytes) })
				if (reason === 'memory budget pressure') { pool.setConcurrency(concurrency.limit(nMaxWorkers)); await pool.trimIdle() }
				if (reason) logVerbose(`Next round worker target: ${concurrency.limit(nMaxWorkers)} (${reason})`)
			}
			logVerbose(`Total gates removed in iteration: ${ gatesRemoved } (${ Math.floor(gatesRemoved/timeDiffMins * 60) } gates/hour)`)
			if (!config.workers.keepBusy && !wholeCircuit && !(restart && currentGates.length < nPrevGates)) {
				beginPhase('shuffling next round')
				const job = nextStrategyJob++
				try { currentGates = await pool.run(currentGates, inputCircuit.wire_count, (_, activity) => strategySummary.observe(job, activity?.strategies), undefined, config.workers.jobSeconds * 1000, false, 'shuffle') }
				finally { strategySummary.finish(job) }
			}
		}
	} finally {
		clearInterval(memoryTimer)
		clearInterval(summaryTimer)
		await pool.close()
		await writer.close()
	}
}
