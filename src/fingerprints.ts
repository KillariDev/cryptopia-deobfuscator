import { config } from './config.js'
import { Gate } from './types.js'
import { LimitedMap } from './limitedMap.js'

const budgets = new WeakMap<LimitedMap<string, boolean>, { bytes: number, bases: WeakSet<WindowFingerprints> }>()

/** Rolling hashes are prefilters only. Cache hits require the exact structural key. */
export class WindowFingerprints {
	private prefix: Uint32Array
	private powers: Uint32Array
	private encoded?: string
	constructor(private gates: Gate[], private maximumBytes = config.cache.windowKeyBytes) {
		this.prefix = new Uint32Array(gates.length + 1)
		this.powers = new Uint32Array(gates.length + 1); this.powers[0] = 1
		const pieces: string[] = []
		let encodable = true
		for (let i = 0; i < gates.length; i++) {
			const gate = gates[i]
			const fields = [gate.a, gate.b, gate.target, gate.gate_i]
			if (fields.every(value => Number.isInteger(value) && value >= 0 && value <= 65535)) pieces.push(String.fromCharCode(...fields))
			else encodable = false
			let token = 0
			for (const value of [gate.a, gate.b, gate.target, gate.gate_i]) token = (Math.imul(token, 31) + value) >>> 0
			this.prefix[i + 1] = (Math.imul(this.prefix[i], 16777619) + token) >>> 0
			this.powers[i + 1] = Math.imul(this.powers[i], 16777619) >>> 0
		}
		if (encodable) this.encoded = pieces.join('')
	}
	key(start: number, end: number) { return `window:${end - start}:${(this.prefix[end] - Math.imul(this.prefix[start], this.powers[end - start])) >>> 0}` }
	exactKey(start: number, end: number) {
		return this.encoded === undefined ? `${this.key(start, end)}:text:${JSON.stringify(this.gates.slice(start, end))}` : `${this.key(start, end)}:binary:${this.encoded.slice(start * 4, end * 4)}`
	}
	seen(cache: LimitedMap<string, boolean>, start: number, end: number) { return cache.has(this.key(start, end)) && cache.has(this.exactKey(start, end)) }
	remember(cache: LimitedMap<string, boolean>, start: number, end: number) {
		const key = this.key(start, end), exact = this.exactKey(start, end)
		if (cache.has(key) && cache.has(exact)) return
		const bytes = 2 * (key.length + exact.length) + 128
		if (bytes > this.maximumBytes) return
		const budget = budgets.get(cache) ?? { bytes: 0, bases: new WeakSet<WindowFingerprints>() }
		const baseBytes = (this.encoded?.length ?? 0) * 2
		if (bytes + baseBytes > this.maximumBytes) return
		if (budget.bytes + bytes + (budget.bases.has(this) ? 0 : baseBytes) > this.maximumBytes) { cache.clear(); budget.bytes = 0; budget.bases = new WeakSet() }
		if (!budget.bases.has(this)) { budget.bytes += baseBytes; budget.bases.add(this) }
		cache.set(key, true); cache.set(exact, true)
		budget.bytes += bytes; budgets.set(cache, budget)
	}
}
