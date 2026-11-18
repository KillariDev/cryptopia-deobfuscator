import { Gate } from './types.js'
import { getVars, simplifyGate } from './utils.js'

const affineControls = new Set([0, 3, 5, 6, 9, 10, 12, 15])

/** Each row is an exact GF(2) affine expression; bit n is the constant term. */
function expressions(gates: Gate[], wires: number[], stopped: () => boolean) {
	const indices = new Map(wires.map((wire, index) => [wire, index]))
	const rows = wires.map((_, index) => 1n << BigInt(index))
	const constant = 1n << BigInt(wires.length)
	for (let index = 0; index < gates.length; index++) {
		if (index % 256 === 0 && stopped()) return undefined
		const gate = gates[index]
		const a = () => rows[indices.get(gate.a)!], b = () => rows[indices.get(gate.b)!]
		let control: bigint
		switch (gate.gate_i) {
			case 0: control = 0n; break
			case 3: control = a(); break
			case 5: control = b(); break
			case 6: control = a() ^ b(); break
			case 9: control = a() ^ b() ^ constant; break
			case 10: control = b() ^ constant; break
			case 12: control = a() ^ constant; break
			case 15: control = constant; break
			default: throw new Error('Non-affine gate in affine synthesis')
		}
		rows[indices.get(gate.target)!] ^= control
	}
	return rows
}

/** Synthesize an invertible affine map, with exact symbolic verification.
 * Singular maps (possible with target/control aliases) are left unchanged. */
export function synthesizeAffine(input: Gate[], maximumWires = 64, deadline = Infinity, shouldStop: () => boolean = () => false): Gate[] | undefined {
	const stopped = () => performance.now() >= deadline || shouldStop()
	const gates: Gate[] = [], used = new Set<number>()
	for (let index = 0; index < input.length; index++) {
		if (index % 256 === 0 && stopped()) return undefined
		const gate = simplifyGate(input[index])
		if (!affineControls.has(gate.gate_i)) return undefined
		gates.push(gate)
		for (const wire of getVars(gate)) used.add(wire)
		if (used.size > maximumWires) return undefined
	}
	const wires = [...used].sort((a, b) => a - b)
	const original = expressions(gates, wires, stopped)
	if (!original) return undefined
	return synthesizeAffineMap(original, wires, input.length, stopped)
}

/** Synthesize a matrix established by an exact symbolic analysis. */
export function synthesizeAffineMap(original: bigint[], wires: number[], maximumGates: number, stopped: () => boolean): Gate[] | undefined {
	const rows = original.slice()
	const bits = wires.map((_, index) => 1n << BigInt(index))
	const constant = 1n << BigInt(wires.length)
	const operations: Gate[] = []
	const addRow = (source: number, target: number) => {
		rows[target] ^= rows[source]
		operations.push({ a: wires[source], b: 0, target: wires[target], gate_i: 3 })
	}
	for (let column = 0; column < wires.length; column++) {
		if (stopped()) return undefined
		const pivot = rows.findIndex((row, index) => index >= column && (row & bits[column]) !== 0n)
		if (pivot < 0) return undefined
		if (pivot !== column) {
			addRow(pivot, column); addRow(column, pivot); addRow(pivot, column)
		}
		for (let row = 0; row < wires.length; row++) if (row !== column && (rows[row] & bits[column]) !== 0n) addRow(column, row)
		if (operations.length >= maximumGates) return undefined
	}
	// Row operations reduce M to I. Their reverse therefore synthesizes M.
	const result = operations.reverse()
	for (let index = 0; index < wires.length; index++) if ((original[index] & constant) !== 0n) result.push({ a: 0, b: 0, target: wires[index], gate_i: 15 })
	if (result.length >= maximumGates) return undefined
	const actual = expressions(result, wires, stopped)
	if (!actual) return undefined
	if (actual.some((row, index) => row !== original[index])) throw new Error('Affine synthesis failed exact symbolic verification')
	return result
}

/** A cheap whole-map decomposition can be worse than small local rewrites.
 * Try bounded subwindows as well, including when a region exceeds the wire cap. */
function simplifyAffineBlock(region: Gate[], maximumWires: number, deadline: number, shouldStop: () => boolean) {
	const direct = synthesizeAffine(region, maximumWires, deadline, shouldStop)
	if (direct) return direct
	for (const size of [2, 4, 8, 16, 32, 64]) {
		if (size >= region.length) break
		const last = region.length - size, positions = Math.min(16, last + 1)
		for (let slot = 0; slot < positions; slot++) {
			if (performance.now() >= deadline || shouldStop()) return undefined
			const start = positions === 1 ? 0 : Math.floor(slot * last / (positions - 1))
			const replacement = synthesizeAffine(region.slice(start, start + size), maximumWires, deadline, shouldStop)
			if (replacement) return [...region.slice(0, start), ...replacement, ...region.slice(start + size)]
		}
	}
	return undefined
}

/** Rewrite affine regions and their bounded subwindows without crossing nonlinear gates. */
export function simplifyAffineRegions(gates: Gate[], maximumWires = 64, deadline = Infinity, shouldStop: () => boolean = () => false): Gate[] {
	const result: Gate[] = []
	let changed = false
	for (let start = 0; start < gates.length;) {
		if (performance.now() >= deadline || shouldStop()) {
			for (let index = start; index < gates.length; index++) result.push(gates[index])
			break
		}
		if (!affineControls.has(simplifyGate(gates[start]).gate_i)) { result.push(gates[start++]); continue }
		let end = start + 1
		while (end < gates.length && affineControls.has(simplifyGate(gates[end]).gate_i)) {
			if (end % 256 === 0 && (performance.now() >= deadline || shouldStop())) break
			end++
		}
		if (performance.now() >= deadline || shouldStop()) {
			for (let index = start; index < gates.length; index++) result.push(gates[index])
			break
		}
		const region = gates.slice(start, end)
		const replacement = region.length > 1 ? simplifyAffineBlock(region, maximumWires, deadline, shouldStop) : undefined
		changed ||= replacement !== undefined
		for (const gate of replacement ?? region) result.push(gate)
		start = end
	}
	return changed ? result : gates
}
