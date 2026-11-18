import { Gate } from './types.js'
import { getVars } from './utils.js'
import { synthesizeAffineMap } from './affine.js'
import { emitQuadraticMap } from './polynomial-synthesis.js'

export type FactoredOptions = { maximumWires: number, maximumNodes: number, maximumEdges: number, stopped: () => boolean, simulationBits?: number }
export type Form = { readonly id: number, readonly atoms: readonly number[], readonly support: bigint, readonly signature: bigint }
export class FactoredLimit extends Error {}
const rules = Array.from({ length: 16 }, (_, f) => {
	const c = (f >> 3) & 1, a = ((f >> 1) & 1) ^ c, b = ((f >> 2) & 1) ^ c
	return { c, a, b, ab: (f & 1) ^ c ^ a ^ b }
})

/** XORs are canonical sets of shared atoms; ANDs stay factored. Hash collisions
 * are resolved by full comparison, so interning is an exact operation. */
export class FactoredGraph {
	readonly forms: Form[] = []
	readonly products: { left: Form, right: Form, support: bigint, signature: bigint }[] = []
	readonly inputs: Form[]
	readonly zero: Form
	readonly one: Form
	private buckets = new Map<number, Form[]>()
	private ands = new Map<string, Form>()
	private indices: Map<number, number>
	private edges = 0
	constructor(readonly wires: number[], readonly options: FactoredOptions) {
		if (wires.length > options.maximumWires) throw new FactoredLimit('wire limit')
		this.indices = new Map(wires.map((wire, i) => [wire, i]))
		this.zero = this.intern([])
		this.one = this.intern([0])
		this.inputs = wires.map((_, i) => this.intern([i + 1]))
	}
	check() { if (this.options.stopped()) throw new FactoredLimit('canceled') }
	private atom(atom: number): { support: bigint, signature: bigint } {
		if (!atom) return { support: 0n, signature: (1n << BigInt(this.options.simulationBits ?? 64)) - 1n }
		if (atom <= this.wires.length) {
			// Deterministic simulation is only a SAT candidate filter, never proof.
			let x = BigInt(atom) * 0x9e3779b97f4a7c15n
			x = BigInt.asUintN(64, (x ^ (x >> 30n)) * 0xbf58476d1ce4e5b9n)
			x = BigInt.asUintN(64, (x ^ (x >> 27n)) * 0x94d049bb133111ebn)
			return { support: 1n << BigInt(atom - 1), signature: BigInt.asUintN(this.options.simulationBits ?? 64, x ^ (x >> 31n)) }
		}
		return this.products[atom - this.wires.length - 1]
	}
	private intern(atoms: number[]): Form {
		this.check()
		let hash = 2166136261
		for (let i = 0; i < atoms.length; i++) { if (!(i % 256)) this.check(); hash = Math.imul(hash ^ atoms[i], 16777619) }
		const bucket = this.buckets.get(hash) ?? []
		for (const prior of bucket) if (prior.atoms.length === atoms.length && prior.atoms.every((atom, i) => atom === atoms[i])) return prior
		if (this.forms.length + this.products.length >= this.options.maximumNodes || this.edges + atoms.length > this.options.maximumEdges) throw new FactoredLimit('graph limit')
		let support = 0n, signature = 0n
		for (const atom of atoms) { const value = this.atom(atom); support |= value.support; signature ^= value.signature }
		const result = { id: this.forms.length, atoms, support, signature }
		this.edges += atoms.length; this.forms.push(result); bucket.push(result); this.buckets.set(hash, bucket)
		return result
	}
	xor(left: Form, right: Form): Form {
		if (left === right) return this.zero
		if (!left.atoms.length) return right
		if (!right.atoms.length) return left
		const atoms: number[] = []
		let i = 0, j = 0
		while (i < left.atoms.length || j < right.atoms.length) {
			if (!((i + j) % 256)) this.check()
			if (j === right.atoms.length || (i < left.atoms.length && left.atoms[i] < right.atoms[j])) atoms.push(left.atoms[i++])
			else if (i === left.atoms.length || right.atoms[j] < left.atoms[i]) atoms.push(right.atoms[j++])
			else { i++; j++ }
		}
		return this.intern(atoms)
	}
	and(left: Form, right: Form): Form {
		if (left === this.zero || right === this.zero) return this.zero
		if (left === right || right === this.one) return left
		if (left === this.one) return right
		const key = left.id < right.id ? `${left.id}:${right.id}` : `${right.id}:${left.id}`
		const prior = this.ands.get(key)
		if (prior) return prior
		this.check()
		if (this.forms.length + this.products.length >= this.options.maximumNodes) throw new FactoredLimit('graph limit')
		this.products.push({ left, right, support: left.support | right.support, signature: left.signature & right.signature })
		const result = this.intern([this.wires.length + this.products.length])
		this.ands.set(key, result)
		return result
	}
	compose(gates: Gate[]): Form[] {
		const rows = this.inputs.slice()
		for (const gate of gates) {
			this.check()
			const rule = rules[gate.gate_i], target = this.indices.get(gate.target)!
			let value = rows[target]
			if (rule.c) value = this.xor(value, this.one)
			if (rule.a) value = this.xor(value, rows[this.indices.get(gate.a)!])
			if (rule.b) value = this.xor(value, rows[this.indices.get(gate.b)!])
			if (rule.ab) value = this.xor(value, this.and(rows[this.indices.get(gate.a)!], rows[this.indices.get(gate.b)!]))
			rows[target] = value // All aliased controls read the old target.
		}
		return rows
	}
	/** Apply only externally proved form identities; earlier representatives
	 * ensure the rewrite cannot introduce cycles. */
	rewrite(rows: Form[], aliases: Map<number, Form>): Form[] {
		const memo = new Map<number, Form>()
		const visit = (form: Form, depth = 0): Form => {
			this.check()
			if (depth > 512) throw new FactoredLimit('expression depth')
			const prior = memo.get(form.id)
			if (prior) return prior
			const alias = aliases.get(form.id)
			if (alias) { if (alias.id >= form.id) throw new Error('Cyclic factored alias'); const value = visit(alias, depth + 1); memo.set(form.id, value); return value }
			let value = this.zero
			for (const atom of form.atoms) {
				const term = atom === 0 ? this.one : atom <= this.wires.length ? this.inputs[atom - 1] : (() => { const node = this.products[atom - this.wires.length - 1]; return this.and(visit(node.left, depth + 1), visit(node.right, depth + 1)) })()
				value = this.xor(value, term)
			}
			memo.set(form.id, value); return value
		}
		return rows.map(row => visit(row))
	}
	/** Compact the live cone after proved merges. Bulk parity interning avoids
	 * constructing every prefix of a wide XOR during congruence rebuilding. */
	rebuild(rows: Form[], aliases: Map<number, Form>) {
		const live = new Set<number>(), pending = rows.slice()
		while (pending.length) {
			this.check()
			const form = pending.pop()!
			if (live.has(form.id)) continue
			live.add(form.id)
			const alias = aliases.get(form.id)
			if (alias) {
				if (alias.id >= form.id) throw new Error('Cyclic factored alias')
				pending.push(alias); continue
			}
			for (const atom of form.atoms) if (atom > this.wires.length) {
				this.check(); const node = this.products[atom - this.wires.length - 1]
				pending.push(node.left, node.right)
			}
		}
		const graph = new FactoredGraph(this.wires, this.options), memo = new Map<number, Form>(), products = new Map<number, Form>()
		let work = 0
		for (const id of [...live].sort((a, b) => a - b)) {
			this.check()
			const alias = aliases.get(id)
			if (alias) { memo.set(id, memo.get(alias.id)!); continue }
			const parity = new Set<number>()
			for (const atom of this.forms[id].atoms) {
				let term: Form
				if (!atom) term = graph.one
				else if (atom <= this.wires.length) term = graph.inputs[atom - 1]
				else {
					const node = this.products[atom - this.wires.length - 1]
					term = products.get(atom) ?? graph.and(memo.get(node.left.id)!, memo.get(node.right.id)!)
					products.set(atom, term)
				}
				for (const next of term.atoms) {
					if (++work > this.options.maximumEdges) throw new FactoredLimit('rebuild limit')
					this.check(); if (!parity.delete(next)) parity.add(next)
				}
			}
			memo.set(id, graph.intern([...parity].sort((a, b) => a - b)))
		}
		return { graph, rows: rows.map(row => memo.get(row.id)!) }
	}
	/** Expand only final low-degree expressions, not nonlinear intermediates. */
	private quadratic(rows: Form[]): Set<bigint>[] | undefined {
		const memo = new Map<number, Set<bigint> | undefined>()
		let work = 0
		const toggle = (set: Set<bigint>, term: bigint) => { if (++work > this.options.maximumEdges) throw new FactoredLimit('output limit'); this.check(); if (!set.delete(term)) set.add(term) }
		const expand = (form: Form, depth = 0): Set<bigint> | undefined => {
			this.check()
			if (depth > 512) throw new FactoredLimit('expression depth')
			if (memo.has(form.id)) return memo.get(form.id)
			const result = new Set<bigint>()
			for (const atom of form.atoms) {
				if (!atom) toggle(result, 0n)
				else if (atom <= this.wires.length) toggle(result, 1n << BigInt(atom - 1))
				else {
					const node = this.products[atom - this.wires.length - 1], left = expand(node.left, depth + 1), right = expand(node.right, depth + 1)
					if (!left || !right) { memo.set(form.id, undefined); return undefined }
					for (const a of left) for (const b of right) {
						const term = a | b, rest = term & (term - 1n)
						if (rest && (rest & (rest - 1n))) { memo.set(form.id, undefined); return undefined }
						toggle(result, term)
					}
				}
			}
			memo.set(form.id, result); return result
		}
		const result = rows.map(row => expand(row))
		return result.some(row => !row) ? undefined : result as Set<bigint>[]
	}
	emit(rows: Form[], maximumGates: number): Gate[] | undefined {
		const polynomials = this.quadratic(rows)
		if (!polynomials) return undefined
		const allAffine = polynomials.every(row => [...row].every(term => !term || !(term & (term - 1n))))
		const result = allAffine
			? synthesizeAffineMap(polynomials.map(row => [...row].reduce((bits, term) => bits ^ (term || (1n << BigInt(this.wires.length))), 0n)), this.wires, maximumGates, this.options.stopped)
			: emitQuadraticMap(polynomials, this.wires, maximumGates, this.options.stopped)
		if (!result) return undefined
		const actual = this.quadratic(this.compose(result))
		if (!actual) return undefined
		if (actual.some((row, i) => row.size !== polynomials[i].size || [...row].some(term => !polynomials[i].has(term)))) throw new Error('Factored emission failed exact verification')
		return result
	}
}

export function analyzeFactored(gates: Gate[], options: FactoredOptions) {
	const used = new Set<number>()
	for (const gate of gates) {
		if (options.stopped()) throw new FactoredLimit('canceled')
		for (const wire of getVars(gate)) used.add(wire)
		if (used.size > options.maximumWires) throw new FactoredLimit('wire limit')
	}
	const graph = new FactoredGraph([...used].sort((a, b) => a - b), options)
	return { graph, rows: graph.compose(gates) }
}

export function synthesizeFactored(gates: Gate[], options: FactoredOptions): Gate[] | undefined {
	try { const { graph, rows } = analyzeFactored(gates, options); return graph.emit(rows, gates.length) }
	catch (error) { if (error instanceof FactoredLimit) return undefined; throw error }
}
