import { StrategyPicker } from './strategy-picker.js'
import { searchAffineRegions } from './symbolic-affine.js'
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
const picker = new StrategyPicker(['gf2-affine', 'forward-semantic-search', 'z3', 'meet-in-the-middle', 'equality-saturation'])
export type SynthesisBudget = { deadline: number, shouldStop?: () => boolean }
// Serialize synthesis so Z3 initialization and cleanup cannot overlap.
let pending: Promise<unknown> = Promise.resolve()
export async function advancedRewrite(gates: Gate[], budget: SynthesisBudget = { deadline: performance.now() + config.workers.jobSeconds * 1000 }): Promise<Gate[] | undefined> {
	const options = config.synthesis
	if (!(options.affine || options.forwardSemanticSearch || options.smt || options.meetInMiddle || options.equalitySaturation) || gates.length > Math.max(options.maximumWindowGates, options.affine ? options.affineMaximumWindowGates : 0)) return undefined
	const { normalized, wires, key } = normalizeWindow(gates)
	const small = wires.length <= options.maximumWires && gates.length <= options.maximumWindowGates
	const affine = options.affine && gates.length <= options.affineMaximumWindowGates && wires.length <= config.validation.maximumWires
	if (!small && !affine) return undefined
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
		// Cache failures per strategy: a capped forward semantic search must not exclude Z3.
		const available = choices.filter(choice => !failed.has(`${choice.name}:${key}`))
		const choice = picker.pick(available)
		if (!choice) return undefined
		const started = performance.now()
		const result = await choice.run()
		const accepted = result !== undefined && isReplacementSimpler(result, normalized) && (choice.name === 'gf2-affine' || templates.learn(normalized, result))
		const settings = choice.name === 'gf2-affine'
			? { maximumWires: config.validation.maximumWires, maximumWindowGates: options.affineMaximumWindowGates, workerJobSeconds: config.workers.jobSeconds }
			: { maximumWires: options.maximumWires, maximumWindowGates: options.maximumWindowGates, maximumReplacementGates: options.maximumReplacementGates, ...(choice.name !== 'z3' ? { states: options.states } : {}), workerJobSeconds: config.workers.jobSeconds }
		recordStrategy(choice.name, settings, started, normalized.length, accepted ? result!.length : normalized.length, accepted)
		if (accepted) return reverseMapCircuit(result!, wires)
		if (!stopped()) failed.set(`${choice.name}:${key}`, true)
		return undefined
	})
	pending = job.catch(() => {})
	return job
}

/** A scheduled worker turn, separate from the bounded local synthesis window. */
export function wholeCircuitAffineSearch(gates: Gate[], budgetMs: number, shouldStop: () => boolean) {
	if (!config.synthesis.affine) return gates
	const started = performance.now()
	const result = searchAffineRegions(gates, config.validation.maximumWires, config.synthesis.affineMaximumTerms, config.synthesis.affineMaximumOperations, started + budgetMs, shouldStop)
	recordStrategy('gf2-affine-whole', { maximumWires: config.validation.maximumWires, timeoutMs: budgetMs }, started, gates.length, result.length, result !== gates)
	return result
}
