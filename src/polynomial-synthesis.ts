import { Gate } from './types.js'

/** Emit triangular quadratic maps in an order that keeps controls at input values.
 * Cyclic dependencies, target-dependent deltas and higher degrees are declined. */
export function emitQuadraticMap(rows: Set<bigint>[], wires: number[], maximumGates: number, stopped: () => boolean): Gate[] | undefined {
	const bits = wires.map((_, i) => 1n << BigInt(i))
	const deltas = rows.map((row, i) => {
		const delta = new Set(row)
		if (delta.has(bits[i])) delta.delete(bits[i]); else delta.add(bits[i])
		return delta
	})
	const changed = deltas.map((delta, i) => delta.size ? i : -1).filter(i => i >= 0)
	const dependencies = wires.map(() => new Set<number>()), incoming = wires.map(() => 0)
	for (const target of changed) for (const monomial of deltas[target]) {
		if (stopped()) return undefined
		if ((monomial & bits[target]) !== 0n) return undefined
		const controls = bits.flatMap((bit, i) => (monomial & bit) !== 0n ? [i] : [])
		if (controls.length > 2) return undefined
		for (const control of controls) if (deltas[control].size && !dependencies[target].has(control)) {
			// This output must read the control before that control is changed.
			dependencies[target].add(control); incoming[control]++
		}
	}
	const ready = changed.filter(i => incoming[i] === 0), order: number[] = []
	while (ready.length) {
		ready.sort((a, b) => a - b)
		const target = ready.shift()!
		order.push(target)
		for (const control of dependencies[target]) if (--incoming[control] === 0) ready.push(control)
	}
	if (order.length !== changed.length) return undefined
	const result: Gate[] = []
	for (const target of order) {
		if (stopped()) return undefined
		let constant = deltas[target].has(0n)
		const singles: number[] = [], pairs: number[][] = []
		for (const monomial of [...deltas[target]].sort((a, b) => a < b ? -1 : a > b ? 1 : 0)) {
			if (!monomial) continue
			const controls = bits.flatMap((bit, i) => (monomial & bit) !== 0n ? [wires[i]] : [])
			if (controls.length === 1) singles.push(controls[0]); else pairs.push(controls)
		}
		for (const [a, b] of pairs) { result.push({ a, b, target: wires[target], gate_i: constant ? 14 : 1 }); constant = false }
		for (let i = 0; i < singles.length; i += 2) {
			const a = singles[i], b = singles[i + 1]
			result.push({ a, b: b ?? 0, target: wires[target], gate_i: b === undefined ? (constant ? 12 : 3) : (constant ? 9 : 6) })
			constant = false
		}
		if (constant) result.push({ a: 0, b: 0, target: wires[target], gate_i: 15 })
		if (result.length >= maximumGates) return undefined
	}
	return result
}

/** Reuse one shared pair across cubic terms using a borrowed, restored wire. */
export function emitSharedCubicMap(rows: Set<bigint>[], wires: number[], maximumGates: number, stopped: () => boolean, spend: () => boolean): Gate[] | undefined {
	const bits = wires.map((_, i) => 1n << BigInt(i))
	const unchanged = rows.map((row, i) => row.size === 1 && row.has(bits[i]))
	const cubic: { target: number, term: bigint }[] = []
	let usedControls = 0n
	for (let target = 0; target < rows.length; target++) {
		for (const term of rows[target]) {
			if (spend()) return undefined
			if (term === bits[target]) continue
			usedControls |= term
			let remaining = term
			for (let degree = 1; remaining !== 0n; degree++) {
				remaining &= remaining - 1n
				if (degree > 3) return undefined
				if (degree === 3) cubic.push({ target, term })
			}
		}
	}
	// A single cubic gets no savings from sharing the compute and restore gates.
	if (cubic.length < 2 || 2 * cubic.length + 2 >= maximumGates || stopped()) return undefined
	const borrowed = bits.findIndex((bit, i) => unchanged[i] && !(usedControls & bit))
	if (borrowed < 0) return undefined
	const stable = bits.reduce((mask, bit, i) => unchanged[i] ? mask | bit : mask, 0n)
	const shared = cubic.reduce((mask, { term }) => mask & term, stable)
	const pair = bits.flatMap((bit, i) => shared & bit ? [i] : []).slice(0, 2)
	if (pair.length < 2) return undefined
	const [a, b] = pair
	const product = bits[a] | bits[b]
	const middle = rows.map(row => new Set(row))
	const corrections: Gate[] = []
	for (const { target, term } of cubic) {
		if (spend() || (term & stable) !== term) return undefined
		const other = term ^ product
		middle[target].delete(term)
		middle[target].add(bits[borrowed] | other)
		corrections.push({ a: wires[borrowed], b: wires[bits.indexOf(other)], target: wires[target], gate_i: 1 })
	}
	const body = emitQuadraticMap(middle, wires, maximumGates - corrections.length - 2, stopped)
	if (!body) return undefined
	// The body adds (borrowed XOR (a AND b)) AND other. After restoring
	// the borrowed wire, the correction removes its original contribution.
	const toggle = { a: wires[a], b: wires[b], target: wires[borrowed], gate_i: 1 }
	return [toggle, ...body, toggle, ...corrections]
}
