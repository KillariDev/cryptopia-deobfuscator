import { config } from './config.js'
import { Gate } from './types.js'
import { analyzeFactored, FactoredLimit, synthesizeFactored } from './factored.js'
import type { FactoredOptions } from './factored.js'
import { cancelBlocks } from './block-cancellation.js'
import { runSolverWorker } from './solver-worker.js'
import { recordStrategy } from './strategy-stats.js'

export const structuralNames = ['factored', 'block-cancellation', 'sat-sweeping'] as const
export type StructuralStrategy = typeof structuralNames[number]
export function structuralChoices() {
	return structuralNames.filter(name => name === 'factored' ? config.synthesis.factored : name === 'block-cancellation' ? config.synthesis.blockCancellation : config.synthesis.satSweeping)
}

async function satRewrite(gates: Gate[], options: FactoredOptions, deadline: number) {
	// Most small windows have no equivalent expressions to sweep. Avoid an
	// isolate (and WASM initialization) for those cheap negative results.
	if (gates.length <= config.synthesis.affineMaximumWindowGates) {
		try {
			const { graph, rows } = analyzeFactored(gates, options)
			const result = graph.emit(rows, gates.length)
			if (result) return result
			const seen = new Set<bigint>()
			let candidate = false
			for (const form of graph.forms) { graph.check(); if (seen.has(form.signature)) { candidate = true; break }; seen.add(form.signature) }
			if (!candidate) return undefined
		} catch (error) { if (error instanceof FactoredLimit) return undefined; throw error }
	}
	return runSolverWorker(new URL('./sat-sweeping-worker.js', import.meta.url), { gates, maximumWires: options.maximumWires, maximumNodes: options.maximumNodes, maximumEdges: options.maximumEdges, budgetMs: Math.max(0, deadline - performance.now()) }, Math.max(0, deadline - performance.now()), options.stopped)
}

export async function structuralRewrite(name: StructuralStrategy, gates: Gate[], deadline: number, shouldStop: () => boolean = () => false): Promise<Gate[] | undefined> {
	const started = performance.now()
	const stopped = () => performance.now() >= deadline || shouldStop()
	if (stopped()) return undefined
	const options = { maximumWires: config.validation.maximumWires, maximumNodes: config.synthesis.factoredMaximumNodes, maximumEdges: config.synthesis.factoredMaximumEdges, stopped }
	const result = name === 'factored' ? synthesizeFactored(gates, options)
		: name === 'block-cancellation' ? cancelBlocks(gates, options)
		: await satRewrite(gates, options, deadline)
	const accepted = result !== undefined && result.length < gates.length
	recordStrategy(name, { maximumWires: options.maximumWires, maximumNodes: options.maximumNodes, maximumEdges: options.maximumEdges }, started, gates.length, accepted ? result!.length : gates.length, accepted)
	return accepted ? result : undefined
}
