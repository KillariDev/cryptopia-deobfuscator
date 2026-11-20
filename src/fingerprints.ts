import { config } from './config.js'
import { Gate } from './types.js'
import { LimitedMap } from './limitedMap.js'

const budgets = new WeakMap<LimitedMap<string, boolean>, number>()
const keyBytes = (key: string) => 2 * key.length + 64

const keyCopyScratch = Buffer.allocUnsafe(4096)

// Copy retained keys so a short window cannot keep the full encoding alive.
export const retainWindowKey = (key: string) => {
	const bytes = key.length * 2
	if (bytes > keyCopyScratch.length) return Buffer.from(key, 'utf16le').toString('utf16le')
	keyCopyScratch.write(key, 0, bytes, 'utf16le')
	return keyCopyScratch.toString('utf16le', 0, bytes)
}

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
	private exactKeyWithRollingKey(start: number, end: number, key: string) {
		return this.encoded === undefined ? `${key}:text:${JSON.stringify(this.gates.slice(start, end))}` : `${key}:binary:${this.encoded.slice(start * 4, end * 4)}`
	}
	exactKey(start: number, end: number) {
		return this.exactKeyWithRollingKey(start, end, this.key(start, end))
	}
	seen(cache: LimitedMap<string, boolean>, start: number, end: number) {
		const key = this.key(start, end)
		return cache.has(key) && cache.has(this.exactKeyWithRollingKey(start, end, key))
	}
	remember(cache: LimitedMap<string, boolean>, start: number, end: number) {
		const key = this.key(start, end), exact = this.exactKeyWithRollingKey(start, end, key)
		const hasKey = cache.has(key)
		if (hasKey && cache.has(exact)) return
		const rollingBytes = keyBytes(key), exactBytes = keyBytes(exact)
		const newBytes = rollingBytes + exactBytes
		if (newBytes > this.maximumBytes) return
		let bytes = cache.size() ? budgets.get(cache) ?? 0 : 0
		if (hasKey) {
			cache.delete(key)
			bytes -= rollingBytes
		} else if (cache.delete(exact)) bytes -= exactBytes
		while (bytes + newBytes > this.maximumBytes && cache.size()) {
			const oldest = cache.evictOldest()!
			bytes -= keyBytes(oldest)
		}
		const retained = retainWindowKey(exact)
		const rollingEviction = cache.set(key, true)
		const exactEviction = cache.set(retained, true)
		bytes += newBytes - (rollingEviction === undefined ? 0 : keyBytes(rollingEviction)) -
			(exactEviction === undefined ? 0 : keyBytes(exactEviction))
		budgets.set(cache, bytes)
	}
}
