import { simplifyAffineRegions } from './affine.js'
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
let checks = 0
// Serialize synthesis so Z3 initialization and cleanup cannot overlap.
let pending: Promise<unknown> = Promise.resolve()
export async function advancedRewrite(gates: Gate[], random = Math.random): Promise<Gate[] | undefined> {
	const options = config.synthesis
	if (!(options.forwardSemanticSearch || options.smt || options.meetInMiddle || options.equalitySaturation) || gates.length > options.maximumWindowGates || ++checks % options.attemptEvery !== 0) return undefined
	const { normalized, wires, key } = normalizeWindow(gates)
	if (wires.length > options.maximumWires) return undefined
	const job = pending.then(async () => {
		const choices: { name: string, run: () => Gate[] | undefined | Promise<Gate[] | undefined> }[] = []
		if (options.forwardSemanticSearch) choices.push({ name: 'forward-semantic-search', run: () => forwardSemanticSearch(normalized, wires.length, options.maximumReplacementGates, options.states, options.timeoutMs) })
		if (options.smt) choices.push({ name: 'z3', run: () => synthesizeSMT(normalized, wires.length, options.maximumReplacementGates, options.timeoutMs) })
		if (options.meetInMiddle) choices.push({ name: 'meet-in-the-middle', run: () => meetInMiddle(normalized, wires.length, [...generateAllGates(wires.length)], Math.min(options.maximumReplacementGates, gates.length - 1), options.states, options.timeoutMs) })
		if (options.equalitySaturation) choices.push({ name: 'equality-saturation', run: () => saturateCircuit(normalized, wires.length, templates, options.states, options.timeoutMs) })
		// Cache failures per strategy: a capped forward semantic search must not exclude Z3.
		const available = choices.filter(choice => !failed.has(`${choice.name}:${key}`))
		if (!available.length) return undefined
		const choice = available[Math.floor(random() * available.length)]
		const started = performance.now()
		const result = await choice.run()
		const accepted = result !== undefined && isReplacementSimpler(result, normalized) && templates.learn(normalized, result)
		recordStrategy(choice.name, { maximumWires: options.maximumWires, maximumWindowGates: options.maximumWindowGates, maximumReplacementGates: options.maximumReplacementGates, ...(choice.name !== 'z3' ? { states: options.states } : {}), timeoutMs: options.timeoutMs, attemptEvery: options.attemptEvery }, started, normalized.length, accepted ? result!.length : normalized.length, accepted)
		if (accepted) return reverseMapCircuit(result!, wires)
		failed.set(`${choice.name}:${key}`, true)
		return undefined
	})
	pending = job.catch(() => {})
	return job
}

/** Global/region affine synthesis has its own polynomial bound, not the tiny SMT window. */
export function affineRewrite(gates: Gate[]) {
	if (!config.synthesis.affine) return gates
	const started = performance.now()
	const result = simplifyAffineRegions(gates, config.validation.maximumWires)
	recordStrategy('gf2-affine', { maximumWires: config.validation.maximumWires }, started, gates.length, result.length, result !== gates)
	return result
}
