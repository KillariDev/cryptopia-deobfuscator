import type { Gate } from './types.js'
import { getVars } from './utils.js'

/** Gate order has no effect on operand or pair frequencies. */
export function circuitWireCost(gates: Gate[]) {
	const counts = new Map<string, number>()
	let operands = 0, pairUses = 0, squaredCounts = 0
	for (const gate of gates) {
		const wires = getVars(gate).filter((wire, i, used) => used.indexOf(wire) === i)
		operands += wires.length
		for (let i = 0; i < wires.length; i++) {
			for (let j = i + 1; j < wires.length; j++) {
				const a = Math.min(wires[i], wires[j]), b = Math.max(wires[i], wires[j])
				const key = `${a}:${b}`
				const previous = counts.get(key) ?? 0
				counts.set(key, previous + 1)
				pairUses++
				squaredCounts += 2 * previous + 1
			}
		}
	}
	return { operands, effectivePairs: pairUses ? pairUses ** 2 / squaredCounts : 0 }
}

/** With equal gate counts, total operands and mean operands order identically. */
export function isBetterCircuit(candidate: Gate[], baseline: Gate[]) {
	if (candidate.length !== baseline.length) return candidate.length < baseline.length
	if (candidate === baseline) return false
	const next = circuitWireCost(candidate), previous = circuitWireCost(baseline)
	return next.operands !== previous.operands ? next.operands < previous.operands : next.effectivePairs < previous.effectivePairs
}
