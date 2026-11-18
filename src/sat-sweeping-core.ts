import { Gate } from './types.js'
import { analyzeFactored, FactoredGraph, FactoredLimit, FactoredOptions, Form } from './factored.js'
import { reportSmtDiagnostic } from './smt-solver.js'

export type SweepStats = { queries: number, merges: number, counterexamples: number, passes?: number, rebuilds?: number, coneNodes?: number, refinementSkips?: number }

/** Evaluate concrete counterexamples in topological order. These refine the
 * candidate filter only; they never authorize a rewrite. */
function simulate(graph: FactoredGraph, assignment: bigint): boolean[] {
	const values: boolean[] = [], products = new Map<number, boolean>()
	for (const form of graph.forms) {
		graph.check()
		let value = false
		for (const atom of form.atoms) {
			graph.check()
			let bit: boolean
			if (!atom) bit = true
			else if (atom <= graph.wires.length) bit = !!(assignment & (1n << BigInt(atom - 1)))
			else {
				if (!products.has(atom)) {
					const node = graph.products[atom - graph.wires.length - 1]
					products.set(atom, values[node.left.id] && values[node.right.id])
				}
				bit = products.get(atom)!
			}
			value = value !== bit
		}
		values[form.id] = value
	}
	return values
}

/** Simulation suggests identities; only UNSAT miters authorize a merge.
 * Rebuild congruence after each batch and repeat on the compact live cone. */
export async function sweepFactored(gates: Gate[], options: FactoredOptions, deadline: number, stats: SweepStats = { queries: 0, merges: 0, counterexamples: 0 }): Promise<Gate[] | undefined> {
	try {
		const stopped = () => options.stopped() || performance.now() >= deadline
		let working = analyzeFactored(gates, { ...options, stopped })
		const structural = working.graph.emit(working.rows, gates.length)
		if (structural) return structural
		if (stopped()) return undefined
		const signatures = new Set<bigint>()
		let hasCandidates = false
		for (const form of working.graph.forms) {
			working.graph.check()
			if (signatures.has(form.signature)) { hasCandidates = true; break }
			signatures.add(form.signature)
		}
		if (!hasCandidates) return undefined
		const samples: bigint[] = []
		const { init, killThreads } = await import('z3-solver')
		const api = await init({ printErr: reportSmtDiagnostic })
		try {
			const { Solver, Bool, Xor, And, isTrue } = new api.Context('sweeping')
			while (!stopped()) {
				const { graph, rows } = working
				stats.passes = (stats.passes ?? 0) + 1
				const refined = graph.forms.map(() => 0n)
				const refine = (assignment: bigint, index: number) => {
					const bit = 1n << BigInt(index), values = simulate(graph, assignment)
					for (let i = 0; i < values.length; i++) if (values[i]) refined[i] |= bit
				}
				samples.forEach(refine)
				const groups = new Map<string, Form[]>()
				for (const form of graph.forms) {
					graph.check()
					const key = `${form.signature}:${refined[form.id]}`, group = groups.get(key) ?? []
					group.push(form); groups.set(key, group)
				}
				const candidates = [...groups.values()].filter(group => group.length > 1)
				if (!candidates.length) return undefined
				const solver = new Solver(), aliases = new Map<number, Form>()
				try {
					const atoms = [Bool.val(true), ...graph.wires.map((_, i) => Bool.const(`x${i}`)), ...graph.products.map((_, i) => Bool.const(`p${i}`))]
					const expressions = new Map<number, ReturnType<typeof Bool.val>>(), defined = new Set<number>()
					const expression = (form: Form, depth = 0): ReturnType<typeof Bool.val> => {
						graph.check()
						if (depth > 512) throw new FactoredLimit('SAT expression depth')
						const prior = expressions.get(form.id)
						if (prior) return prior
						const terms = []
						for (const atom of form.atoms) {
							graph.check()
							if (atom > graph.wires.length && !defined.has(atom)) {
								const node = graph.products[atom - graph.wires.length - 1]
								const left = expression(node.left, depth + 1), right = expression(node.right, depth + 1)
								solver.add(atoms[atom].eq(And(left, right))); defined.add(atom)
								stats.coneNodes = (stats.coneNodes ?? 0) + 1
							}
							terms.push(atoms[atom])
						}
						let level = terms
						while (level.length > 1) {
							graph.check(); const next = []
							for (let i = 0; i < level.length; i += 2) { graph.check(); next.push(i + 1 < level.length ? Xor(level[i], level[i + 1]) : level[i]) }
							level = next
						}
						const value = level[0] ?? Bool.val(false); expressions.set(form.id, value); return value
					}
					for (const group of candidates) {
						const representatives: Form[] = []
						for (const form of group) {
							graph.check()
							let merged = false
							for (const prior of representatives) {
								graph.check()
								if (refined[form.id] !== refined[prior.id]) { stats.refinementSkips = (stats.refinementSkips ?? 0) + 1; continue }
								// Define cones outside push/pop, so cached expressions always
								// retain their permanent definitions after a miter is removed.
								const left = expression(form), right = expression(prior)
								solver.push()
								let result: 'sat' | 'unsat' | 'unknown', assignment: bigint | undefined
								try {
									graph.check(); solver.set('timeout', Math.max(1, Math.floor(deadline - performance.now())))
									solver.add(Xor(left, right)); stats.queries++; result = await solver.check()
									if (result === 'sat') {
										const model = solver.model()
										try {
											assignment = 0n
											for (let i = 0; i < graph.wires.length; i++) if (isTrue(model.eval(atoms[i + 1], true))) assignment |= 1n << BigInt(i)
										} finally { model.release() }
									}
								} finally { solver.pop() }
								if (result === 'unsat') {
									aliases.set(form.id, prior); stats.merges++; merged = true
									solver.add(left.eq(right)) // Reuse the proved lemma in later miters.
									break
								}
								if (assignment !== undefined) { stats.counterexamples++; samples.push(assignment); refine(assignment, samples.length - 1) }
							}
							if (!merged) representatives.push(form)
						}
					}
				} finally { solver.release() }
				if (!aliases.size) return undefined
				working = graph.rebuild(rows, aliases)
				stats.rebuilds = (stats.rebuilds ?? 0) + 1
				const result = working.graph.emit(working.rows, gates.length)
				if (result) return result
			}
			return undefined
		} finally { await killThreads(api.em) }
	} catch (error) { if (error instanceof FactoredLimit) return undefined; throw error }
}
