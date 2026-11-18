import { Gate } from './types.js'
import { analyzeFactored, FactoredLimit, FactoredOptions, Form } from './factored.js'
import { reportSmtDiagnostic } from './smt-solver.js'

export type SweepStats = { queries: number, merges: number, counterexamples: number }

/** Simulation suggests identities; only UNSAT miters authorize a merge. */
export async function sweepFactored(gates: Gate[], options: FactoredOptions, deadline: number, stats: SweepStats = { queries: 0, merges: 0, counterexamples: 0 }): Promise<Gate[] | undefined> {
	try {
		const stopped = () => options.stopped() || performance.now() >= deadline
		const { graph, rows } = analyzeFactored(gates, { ...options, stopped })
		const structural = graph.emit(rows, gates.length)
		if (structural) return structural
		const groups = new Map<bigint, Form[]>()
		for (const form of graph.forms) { graph.check(); const group = groups.get(form.signature) ?? []; group.push(form); groups.set(form.signature, group) }
		const candidates = [...groups.values()].filter(group => group.length > 1)
		if (!candidates.length || stopped()) return undefined
		const { init, killThreads } = await import('z3-solver')
		const api = await init({ printErr: reportSmtDiagnostic })
		try {
			graph.check()
			const { Solver, Bool, Xor, And } = new api.Context('sweeping')
			const solver = new Solver(), aliases = new Map<number, Form>()
			try {
				const atoms = [Bool.val(true), ...graph.wires.map((_, i) => Bool.const(`x${i}`)), ...graph.products.map((_, i) => Bool.const(`p${i}`))]
				const expressions = new Map<number, ReturnType<typeof Bool.val>>()
				const expression = (form: Form) => {
					const prior = expressions.get(form.id)
					if (prior) return prior
					let level = form.atoms.map(atom => atoms[atom])
					while (level.length > 1) { graph.check(); const next = []; for (let i = 0; i < level.length; i += 2) next.push(i + 1 < level.length ? Xor(level[i], level[i + 1]) : level[i]); level = next }
					const value = level[0] ?? Bool.val(false); expressions.set(form.id, value); return value
				}
				graph.products.forEach((node, i) => { graph.check(); solver.add(atoms[graph.wires.length + 1 + i].eq(And(expression(node.left), expression(node.right)))) })
				const outputIds = new Set(rows.map(row => row.id))
				for (const group of candidates) {
					const representatives: Form[] = []
					for (const form of group) {
						graph.check()
						let merged = false
						for (const prior of representatives) {
							graph.check()
							if (performance.now() >= deadline) return undefined
							solver.push()
							let result: 'sat' | 'unsat' | 'unknown'
							try {
								solver.set('timeout', Math.max(1, Math.floor(deadline - performance.now())))
								solver.add(Xor(expression(form), expression(prior)))
								stats.queries++; result = await solver.check()
							} finally { solver.pop() }
							if (result === 'unsat') {
								aliases.set(form.id, prior); stats.merges++; merged = true
								if (outputIds.has(form.id)) { const next = graph.emit(graph.rewrite(rows, aliases), gates.length); if (next) return next }
								break
							}
							if (result === 'sat') stats.counterexamples++
						}
						if (!merged) representatives.push(form)
					}
				}
				return aliases.size ? graph.emit(graph.rewrite(rows, aliases), gates.length) : undefined
			} finally { solver.release() }
		} finally { await killThreads(api.em) }
	} catch (error) { if (error instanceof FactoredLimit) return undefined; throw error }
}
