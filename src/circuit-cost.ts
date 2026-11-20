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
export function isBetterCircuit(candidate: Gate[], baseline: Gate[], baselineCosts?: WeakMap<Gate[], ReturnType<typeof circuitWireCost>>) {
	if (candidate.length !== baseline.length) return candidate.length < baseline.length
	if (candidate === baseline) return false
	const next = circuitWireCost(candidate)
	let previous = baselineCosts?.get(baseline)
	if (!previous) {
		previous = circuitWireCost(baseline)
		baselineCosts?.set(baseline, previous)
	}
	return next.operands !== previous.operands ? next.operands < previous.operands : next.pairUses < previous.pairUses
}

/** Coordinator snapshots are replaced by reference when their gates change. */
export function withCachedBaselineCosts() {
	const costs = new WeakMap<Gate[], ReturnType<typeof circuitWireCost>>()
	return (candidate: Gate[], baseline: Gate[]) => isBetterCircuit(candidate, baseline, costs)
}
