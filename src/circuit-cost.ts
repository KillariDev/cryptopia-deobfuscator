import type { Gate } from './types.js'
import { getVars } from './utils.js'

export function circuitWireCost(gates: Gate[]) {
	let operands = 0, pairUses = 0
	for (const gate of gates) {
		const wires = getVars(gate)
		const count = wires.filter((wire, index) => wires.indexOf(wire) === index).length
		operands += count
		pairUses += count * (count - 1) / 2
	}
	return { operands, pairUses }
}

/** Wire costs are additive, so the same ranking applies to a chunk replacement. */
export function isBetterCircuit(candidate: Gate[], baseline: Gate[]) {
	if (candidate.length !== baseline.length) return candidate.length < baseline.length
	if (candidate === baseline) return false
	const next = circuitWireCost(candidate), previous = circuitWireCost(baseline)
	return next.operands !== previous.operands ? next.operands < previous.operands : next.pairUses < previous.pairUses
}
