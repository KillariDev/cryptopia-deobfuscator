import { Gate } from './types.js'
import { getVars, simplifyGate } from './utils.js'

const affineControls = new Set([0, 3, 5, 6, 9, 10, 12, 15])

/** Each row is an exact GF(2) affine expression; bit n is the constant term. */
function expressions(gates: Gate[], wires: number[]) {
	const indices = new Map(wires.map((wire, index) => [wire, index]))
	const rows = wires.map((_, index) => 1n << BigInt(index))
	const constant = 1n << BigInt(wires.length)
	for (const gate of gates) {
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
export function synthesizeAffine(input: Gate[], maximumWires = 64): Gate[] | undefined {
	const gates = input.map(simplifyGate)
	if (!gates.every(gate => affineControls.has(gate.gate_i))) return undefined
	const wires = [...new Set(gates.flatMap(getVars))].sort((a, b) => a - b)
	if (wires.length > maximumWires) return undefined
	const original = expressions(gates, wires), rows = original.slice()
	const bits = wires.map((_, index) => 1n << BigInt(index))
	const constant = 1n << BigInt(wires.length)
	const operations: Gate[] = []
	const addRow = (source: number, target: number) => {
		rows[target] ^= rows[source]
		operations.push({ a: wires[source], b: 0, target: wires[target], gate_i: 3 })
	}
	for (let column = 0; column < wires.length; column++) {
		const pivot = rows.findIndex((row, index) => index >= column && (row & bits[column]) !== 0n)
		if (pivot < 0) return undefined
		if (pivot !== column) {
			addRow(pivot, column); addRow(column, pivot); addRow(pivot, column)
		}
		for (let row = 0; row < wires.length; row++) if (row !== column && (rows[row] & bits[column]) !== 0n) addRow(column, row)
		if (operations.length >= input.length) return undefined
	}
	// Row operations reduce M to I. Their reverse therefore synthesizes M.
	const result = operations.reverse()
	for (let index = 0; index < wires.length; index++) if ((original[index] & constant) !== 0n) result.push({ a: 0, b: 0, target: wires[index], gate_i: 15 })
	if (result.length >= input.length) return undefined
	const actual = expressions(result, wires)
	if (actual.some((row, index) => row !== original[index])) throw new Error('Affine synthesis failed exact symbolic verification')
	return result
}

/** Rewrite maximal affine regions without crossing nonlinear gates. */
export function simplifyAffineRegions(gates: Gate[], maximumWires = 64): Gate[] {
	const result: Gate[] = []
	let changed = false
	for (let start = 0; start < gates.length;) {
		if (!affineControls.has(simplifyGate(gates[start]).gate_i)) { result.push(gates[start++]); continue }
		let end = start + 1
		while (end < gates.length && affineControls.has(simplifyGate(gates[end]).gate_i)) end++
		const region = gates.slice(start, end)
		const replacement = region.length > 1 ? synthesizeAffine(region, maximumWires) : undefined
		changed ||= replacement !== undefined
		for (const gate of replacement ?? region) result.push(gate)
		start = end
	}
	return changed ? result : gates
}
