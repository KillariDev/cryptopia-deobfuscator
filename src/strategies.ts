import { AdaptiveStrategyPicker } from './strategy-picker.js'
import { searchAffineRegions, searchPolynomialRegions } from './symbolic-affine.js'
import { synthesizeSMT } from './smt.js'
import { recordStrategy } from './strategy-stats.js'
import { config } from './config.js'
import { Gate } from './types.js'
import { TemplateLibrary } from './templates.js'
import { normalizeWindow } from './search.js'
import { generateAllGates } from './rainbowtable.js'
import { meetInMiddle, forwardSemanticSearch } from './semantic.js'
import { saturateCircuit } from './equality.js'
import { reverseMapCircuit, isReplacementSimpler } from './utils.js'
import { LimitedMap } from './limitedMap.js'

export const templates = new TemplateLibrary(config.synthesis.templateEntries, config.synthesis.maximumWires, config.synthesis.maximumWindowGates, config.workers.sharedTemplateEntries)
const failed = new LimitedMap<string, boolean>(config.synthesis.templateEntries)
const picker = new AdaptiveStrategyPicker(['gf2-affine', 'quadratic', 'forward-semantic-search', 'z3', 'meet-in-the-middle', 'equality-saturation'], () => ({ enabled: config.search.strategyAdaptive, exploration: config.search.strategyExplorationProbability, halfLifeSeconds: config.search.strategyDecayHalfLifeSeconds }))
export type SynthesisBudget = { deadline: number, shouldStop?: () => boolean, broad?: boolean, selectedStrategy?: string }
// Serialize synthesis so Z3 initialization and cleanup cannot overlap.
let pending: Promise<unknown> = Promise.resolve()
export async function advancedRewrite(gates: Gate[], budget: SynthesisBudget = { deadline: performance.now() + config.workers.jobSeconds * 1000 }): Promise<Gate[] | undefined> {
	const options = config.synthesis
	if (!(options.quadratic || options.affine || options.forwardSemanticSearch || options.smt || options.meetInMiddle || options.equalitySaturation) || gates.length > Math.max(options.maximumWindowGates, (options.affine || options.quadratic) ? options.affineMaximumWindowGates : 0)) return undefined
	const { normalized, wires, key } = normalizeWindow(gates)
	const small = wires.length <= options.maximumWires && gates.length <= options.maximumWindowGates
	const affine = options.affine && gates.length <= options.affineMaximumWindowGates && wires.length <= config.validation.maximumWires
	const quadratic = options.quadratic && gates.length <= options.affineMaximumWindowGates && wires.length <= config.validation.maximumWires
	if (!small && !affine && !quadratic) return undefined
	const job = pending.then(async () => {
		const stopped = () => performance.now() >= budget.deadline || budget.shouldStop?.() === true
		if (stopped()) return undefined
		const remaining = () => Math.max(1, Math.ceil(budget.deadline - performance.now()))
		const choices: { name: string, run: () => Gate[] | undefined | Promise<Gate[] | undefined> }[] = []
		if (small && options.forwardSemanticSearch) choices.push({ name: 'forward-semantic-search', run: () => forwardSemanticSearch(normalized, wires.length, options.maximumReplacementGates, options.states, remaining(), stopped) })
		if (small && options.smt) choices.push({ name: 'z3', run: () => synthesizeSMT(normalized, wires.length, options.maximumReplacementGates, remaining(), stopped) })
		if (small && options.meetInMiddle) choices.push({ name: 'meet-in-the-middle', run: () => meetInMiddle(normalized, wires.length, [...generateAllGates(wires.length)], Math.min(options.maximumReplacementGates, gates.length - 1), options.states, remaining(), stopped) })
		if (small && options.equalitySaturation) choices.push({ name: 'equality-saturation', run: () => saturateCircuit(normalized, wires.length, templates, options.states, remaining(), stopped) })
		if (affine) choices.push({ name: 'gf2-affine', run: () => {
			const result = searchAffineRegions(normalized, config.validation.maximumWires, options.affineMaximumTerms, options.affineMaximumOperations, budget.deadline, stopped)
			return result === normalized ? undefined : result
		} })
		if (quadratic) choices.push({ name: 'quadratic', run: () => {
			const result = searchPolynomialRegions(normalized, config.validation.maximumWires, options.affineMaximumTerms, options.affineMaximumOperations, budget.deadline, stopped)
			return result === normalized ? undefined : result
		} })
		// Cache failures per strategy: a capped forward semantic search must not exclude Z3.
		const available = choices.filter(choice => !failed.has(`${choice.name}:${key}`))
		const choice = budget.selectedStrategy ? available.find(choice => choice.name === budget.selectedStrategy) : picker.pick(available)
		if (!choice) return undefined
		const started = performance.now()
		const result = await choice.run()
		const accepted = result !== undefined && isReplacementSimpler(result, normalized) && (['gf2-affine', 'quadratic'].includes(choice.name) || templates.learn(normalized, result))
		const settings = ['gf2-affine', 'quadratic'].includes(choice.name)
			? { maximumWires: config.validation.maximumWires, maximumWindowGates: options.affineMaximumWindowGates, workerJobSeconds: config.workers.jobSeconds }
			: { maximumWires: options.maximumWires, maximumWindowGates: options.maximumWindowGates, maximumReplacementGates: options.maximumReplacementGates, ...(choice.name !== 'z3' ? { states: options.states } : {}), workerJobSeconds: config.workers.jobSeconds }
		recordStrategy(choice.name, settings, started, normalized.length, accepted ? result!.length : normalized.length, accepted)
		picker.observe(choice.name, accepted ? normalized.length - result!.length : 0, performance.now() - started)
		if (accepted) return reverseMapCircuit(result!, wires)
		if (!stopped()) failed.set(`${choice.name}:${key}`, true)
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
	recordStrategy(config.synthesis.quadratic ? 'symbolic-whole' : 'gf2-affine-whole', { maximumWires: config.validation.maximumWires, timeoutMs: budgetMs }, started, gates.length, result.length, result !== gates)
	return result
}
