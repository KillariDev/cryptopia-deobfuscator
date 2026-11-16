import { Gate } from './types.js'
import { evalCircuit, getVars, hashGates, isReplacementSimpler, simplifyGate } from './utils.js'
import { normalizeWindow } from './search.js'
import { functionKey } from './semantic.js'
import { LimitedMap } from './limitedMap.js'

/** Learned templates are admitted only after exhaustive local verification. */
export class TemplateLibrary {
	private rules: LimitedMap<string, Gate[]>
	private lengths = new Set<number>()
	constructor(entries: number, private maximumWires: number, private maximumGates = 8) { this.rules = new LimitedMap(entries) }
	learn(before: Gate[], after: Gate[]) {
		if (before.length > this.maximumGates) return false
		const normalized = normalizeWindow(before)
		if (normalized.wires.length > this.maximumWires || !isReplacementSimpler(after, before)) return false
		const map = new Map(normalized.wires.map((wire, index) => [wire, index]))
		if (after.some(g => getVars(g).some(wire => !map.has(wire)))) return false
		const replacement = after.map(g => ({ a: map.get(g.a) ?? 0, b: map.get(g.b) ?? 0, target: map.get(g.target)!, gate_i: g.gate_i }))
		if (functionKey(normalized.normalized, normalized.wires.length) !== functionKey(replacement, normalized.wires.length)) return false
		this.rules.set(normalized.key, replacement)
		this.lengths.add(before.length)
		return true
	}
	rewrite(gates: Gate[]) {
		for (let start = 0; start < gates.length; start++) {
			for (const length of this.lengths) {
				if (start + length > gates.length) continue
				const { key, wires } = normalizeWindow(gates.slice(start, start + length))
				const match = this.rules.get(key)
				if (match) return [...gates.slice(0, start), ...match.map(g => ({ a: wires[g.a] ?? 0, b: wires[g.b] ?? 0, target: wires[g.target], gate_i: g.gate_i })), ...gates.slice(start + length)]
			}
			const first = simplifyGate(gates[start])
			if (first.gate_i === 0) return [...gates.slice(0, start), ...gates.slice(start + 1)]
			const second = gates[start + 1]
			if (!second || first.target !== second.target) continue
			const controls = [...new Set([...getVars(first).slice(1), ...getVars(second).slice(1)])]
			if (controls.includes(first.target) || controls.length > 2) continue
			const target = first.target
			let f = 0
			for (let a = 0; a <= 1; a++) for (let b = 0; b <= 1; b++) {
				const input: boolean[] = []
				input[target] = false
				if (controls[0] !== undefined) input[controls[0]] = !!a
				if (controls[1] !== undefined) input[controls[1]] = !!b
				if (evalCircuit([first, second], input)[target]) f |= 1 << (3 - (a * 2 + b))
			}
			const combined = simplifyGate({ a: controls[0] ?? target, b: controls[1] ?? controls[0] ?? target, target, gate_i: f })
			const replacement = f === 0 ? [] : [combined]
			return [...gates.slice(0, start), ...replacement, ...gates.slice(start + 2)]
		}
		return gates
	}
}
