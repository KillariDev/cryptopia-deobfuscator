import { config } from './config.js'
import { Gate } from './types.js'
import { LimitedMap } from './limitedMap.js'

const budgets = new WeakMap<LimitedMap<string, boolean>, { bytes: number }>()

/** Rolling hashes are prefilters only. Cache hits require the exact structural key. */
export class WindowFingerprints {
	private prefix: Uint32Array
	private powers: Uint32Array
	constructor(private gates: Gate[], private maximumBytes = config.cache.windowKeyBytes) {
		this.prefix = new Uint32Array(gates.length + 1)
		this.powers = new Uint32Array(gates.length + 1); this.powers[0] = 1
		for (let i = 0; i < gates.length; i++) {
			const gate = gates[i]
			let token = 0
			for (const value of [gate.a, gate.b, gate.target, gate.gate_i]) token = (Math.imul(token, 31) + value) >>> 0
			this.prefix[i + 1] = (Math.imul(this.prefix[i], 16777619) + token) >>> 0
			this.powers[i + 1] = Math.imul(this.powers[i], 16777619) >>> 0
		}
	}
	key(start: number, end: number) { return `window:${end - start}:${(this.prefix[end] - Math.imul(this.prefix[start], this.powers[end - start])) >>> 0}` }
	exactKey(start: number, end: number) {
		let exact = ''
		for (let i = start; i < end; i++) {
			const { a, b, target, gate_i } = this.gates[i]
			if (![a, b, target, gate_i].every(value => Number.isInteger(value) && value >= 0 && value <= 65535)) return `${this.key(start, end)}:text:${JSON.stringify(this.gates.slice(start, end))}`
			exact += String.fromCharCode(a, b, target, gate_i)
		}
		return `${this.key(start, end)}:binary:${exact}`
	}
	seen(cache: LimitedMap<string, boolean>, start: number, end: number) { return cache.has(this.key(start, end)) && cache.has(this.exactKey(start, end)) }
	remember(cache: LimitedMap<string, boolean>, start: number, end: number) {
		const key = this.key(start, end), exact = this.exactKey(start, end)
		if (cache.has(key) && cache.has(exact)) return
		const bytes = 2 * (key.length + exact.length) + 128
		if (bytes > this.maximumBytes) return
		const budget = budgets.get(cache) ?? { bytes: 0 }
		if (budget.bytes + bytes > this.maximumBytes) { cache.clear(); budget.bytes = 0 }
		cache.set(key, true); cache.set(exact, true)
		budget.bytes += bytes; budgets.set(cache, budget)
	}
}
