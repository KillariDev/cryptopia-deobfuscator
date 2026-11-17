import { recordStrategy } from './strategy-stats.js'
import { config } from './config.js'
import { Gate } from './types.js'
import { TemplateLibrary } from './templates.js'
import { normalizeWindow } from './search.js'
import { generateAllGates } from './rainbowtable.js'
import { meetInMiddle, synthesizeNative } from './semantic.js'
import { saturateCircuit } from './equality.js'
import { reverseMapCircuit, isReplacementSimpler } from './utils.js'
import { LimitedMap } from './limitedMap.js'

export const templates = new TemplateLibrary(config.synthesis.templateEntries, config.synthesis.maximumWires, config.synthesis.maximumWindowGates, config.workers.sharedTemplateEntries)
const failed = new LimitedMap<string, boolean>(config.synthesis.templateEntries)
let checks = 0
// Serialize bounded optional synthesis per worker.
let pending: Promise<unknown> = Promise.resolve()
export async function advancedRewrite(gates: Gate[]): Promise<Gate[] | undefined> {
	const options = config.synthesis
	if (!(options.native || options.meetInMiddle || options.equalitySaturation) || gates.length > options.maximumWindowGates || ++checks % options.attemptEvery !== 0) return undefined
	const { normalized, wires, key } = normalizeWindow(gates)
	if (wires.length > options.maximumWires || failed.has(key)) return undefined
	const job = pending.then(async () => {
		let result: Gate[] | undefined
		const attempt = (name: string, run: () => Gate[] | undefined) => {
			const started = performance.now()
			const candidate = run()
			recordStrategy(name, { maximumWires: options.maximumWires, maximumWindowGates: options.maximumWindowGates, maximumReplacementGates: options.maximumReplacementGates, states: options.states, timeoutMs: options.timeoutMs, attemptEvery: options.attemptEvery }, started, normalized.length, candidate?.length ?? normalized.length, candidate !== undefined)
			return candidate
		}
		if (options.equalitySaturation) result = attempt('equality-saturation', () => saturateCircuit(normalized, wires.length, templates, options.states, options.timeoutMs))
		if (!result && options.meetInMiddle) result = attempt('meet-in-the-middle', () => meetInMiddle(normalized, wires.length, [...generateAllGates(wires.length)], Math.min(options.maximumReplacementGates, gates.length - 1), options.states, options.timeoutMs))
		if (!result && options.native) result = attempt('native', () => synthesizeNative(normalized, wires.length, options.maximumReplacementGates, options.states, options.timeoutMs))
		if (result && isReplacementSimpler(result, normalized) && templates.learn(normalized, result)) return reverseMapCircuit(result, wires)
		failed.set(key, true)
		return undefined
	})
	pending = job.catch(() => {})
	return job
}
