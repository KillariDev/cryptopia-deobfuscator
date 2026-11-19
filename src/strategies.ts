import { StrategyPicker } from './strategy-picker.js'
import { searchAffineRegions, searchPolynomialRegions } from './symbolic-affine.js'
import { synthesizeSMT } from './smt.js'
import { recordStrategy } from './strategy-stats.js'
import { config } from './config.js'
import { Gate } from './types.js'
import { normalizeWindow } from './search.js'
import { generateAllGates } from './rainbowtable.js'
import { functionKey, meetInMiddle, forwardSemanticSearch } from './semantic.js'
import { saturateCircuit } from './equality.js'
import { getVars, reverseMapCircuit, isReplacementSimpler } from './utils.js'
import { LimitedMap } from './limitedMap.js'
import { structuralNames, structuralChoices, structuralRewrite } from './structural-strategies.js'

const failed = new LimitedMap<string, boolean>(Math.min(10000, config.cache.processedEntries))
const picker = new StrategyPicker(['gf2-affine', 'anf-synthesis', ...structuralNames, 'forward-semantic-search', 'smt-synthesis', 'meet-in-the-middle', 'commutation-search'])
export type SynthesisBudget = { deadline: number, shouldStop?: () => boolean, broad?: boolean, minimumBroadGates?: number, dependencyRegion?: boolean, onProgress?: () => void, onCut?: (indices: number[], replacement: Gate[]) => void, onCandidate?: (gates: Gate[]) => void, selectedStrategy?: string, exhaustStrategies?: boolean, forceStrategy?: boolean }
// Serialize synthesis so Z3 initialization and cleanup cannot overlap.
let pending: Promise<unknown> = Promise.resolve()
export async function advancedRewrite(gates: Gate[], budget: SynthesisBudget = { deadline: performance.now() + config.workers.jobSeconds * 1000 }): Promise<Gate[] | undefined> {
	const options = config.synthesis
	const structural = structuralChoices()
	if (!(structural.length || options.quadratic || options.affine || options.forwardSemanticSearch || options.smt || options.meetInMiddle || options.equalitySaturation) || gates.length > Math.max(options.maximumWindowGates, (structural.length || options.affine || options.quadratic) ? options.affineMaximumWindowGates : 0)) return undefined
	const { normalized, wires, key } = normalizeWindow(gates)
	const small = wires.length <= options.maximumWires && gates.length <= options.maximumWindowGates
	const affine = options.affine && gates.length <= options.affineMaximumWindowGates && wires.length <= config.validation.maximumWires
	const quadratic = options.quadratic && gates.length <= options.affineMaximumWindowGates && wires.length <= config.validation.maximumWires
	const wideStructural = structural.length > 0 && gates.length <= options.affineMaximumWindowGates && wires.length <= config.validation.maximumWires
	if (!small && !affine && !quadratic && !wideStructural) return undefined
	const job = pending.then(async () => {
		const stopped = () => performance.now() >= budget.deadline || budget.shouldStop?.() === true
		if (stopped()) return undefined
		const remaining = () => Math.max(1, Math.ceil(budget.deadline - performance.now()))
		const choices: { name: string, run: () => Gate[] | undefined | Promise<Gate[] | undefined> }[] = []
		if (wideStructural) for (const name of structural) choices.push({ name, run: () => structuralRewrite(name, normalized, budget.deadline, stopped) })
		if (small && options.forwardSemanticSearch) choices.push({ name: 'forward-semantic-search', run: () => forwardSemanticSearch(normalized, wires.length, options.maximumReplacementGates, options.states, remaining(), stopped) })
		if (small && options.smt) choices.push({ name: 'smt-synthesis', run: () => synthesizeSMT(normalized, wires.length, options.maximumReplacementGates, remaining(), stopped) })
		if (small && options.meetInMiddle) choices.push({ name: 'meet-in-the-middle', run: () => meetInMiddle(normalized, wires.length, [...generateAllGates(wires.length)], Math.min(options.maximumReplacementGates, gates.length - 1), options.states, remaining(), stopped) })
		if (small && options.equalitySaturation) choices.push({ name: 'commutation-search', run: () => saturateCircuit(normalized, wires.length, options.states, remaining(), stopped) })
		if (affine) choices.push({ name: 'gf2-affine', run: () => {
			const result = searchAffineRegions(normalized, config.validation.maximumWires, options.affineMaximumTerms, options.affineMaximumOperations, budget.deadline, stopped)
			return result === normalized ? undefined : result
		} })
		if (quadratic) choices.push({ name: 'anf-synthesis', run: () => {
			const result = searchPolynomialRegions(normalized, config.validation.maximumWires, options.affineMaximumTerms, options.affineMaximumOperations, budget.deadline, stopped)
			return result === normalized ? undefined : result
		} })
		// Cache failures per strategy: a capped forward semantic search must not exclude Z3.
		const available = choices.filter(choice => !failed.has(`${choice.name}:${key}`))
		while (available.length && !stopped()) {
			const choice = budget.selectedStrategy ? available.find(choice => choice.name === budget.selectedStrategy) : picker.pick(available)
			if (!choice) break
			const started = performance.now()
			const result = await choice.run()
			const isStructural = (structuralNames as readonly string[]).includes(choice.name)
			const symbolic = isStructural || choice.name === 'gf2-affine' || choice.name === 'anf-synthesis'
			const accepted = result !== undefined && isReplacementSimpler(result, normalized) &&
				(symbolic || (result.every(gate => getVars(gate).every(wire => wire >= 0 && wire < wires.length)) &&
					functionKey(result, wires.length) === functionKey(normalized, wires.length)))
			const settings = ['gf2-affine', 'anf-synthesis'].includes(choice.name)
				? { maximumWires: config.validation.maximumWires, maximumWindowGates: options.affineMaximumWindowGates, workerJobSeconds: config.workers.jobSeconds }
				: { maximumWires: options.maximumWires, maximumWindowGates: options.maximumWindowGates, maximumReplacementGates: options.maximumReplacementGates, ...(choice.name !== 'smt-synthesis' ? { states: options.states } : {}), workerJobSeconds: config.workers.jobSeconds }
			if (!isStructural) recordStrategy(choice.name, settings, started, normalized.length, accepted ? result!.length : normalized.length, accepted)
			if (accepted) return reverseMapCircuit(result!, wires)
			if (!stopped()) failed.set(`${choice.name}:${key}`, true)
			if (!budget.exhaustStrategies || budget.selectedStrategy || stopped()) break
			available.splice(available.indexOf(choice), 1)
		}
		return undefined
	})
	pending = job.catch(() => {})
	return job
}

/** A scheduled worker turn, separate from the bounded local synthesis window. */
export function wholeCircuitAffineSearch(gates: Gate[], budgetMs: number, shouldStop: () => boolean) {
	if (!config.synthesis.affine && !config.synthesis.quadratic) return gates
	const started = performance.now()
	const search = config.synthesis.quadratic ? searchPolynomialRegions : searchAffineRegions
	const result = search(gates, config.validation.maximumWires, config.synthesis.affineMaximumTerms, config.synthesis.affineMaximumOperations, started + budgetMs, shouldStop)
	recordStrategy(config.synthesis.quadratic ? 'polynomial-region-search' : 'gf2-affine-whole', { maximumWires: config.validation.maximumWires, timeoutMs: budgetMs }, started, gates.length, result.length, result !== gates)
	return result
}
