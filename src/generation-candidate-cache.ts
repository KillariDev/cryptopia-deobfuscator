const wireCounts = Uint8Array.from({ length: 256 }, (_, mask) => { let count = 0; for (; mask; mask &= mask - 1) count++; return count })

/** Exact, direct-mapped cache. Hash collisions evict entries; they never reject
 * a different function. Fixed typed arrays bound retained buffers. Intermediate
 * layers compare matching masks; the final layer can also compare wire costs. */
export class GenerationCandidateCache {
	private keys: Uint8Array
	private masks: Uint8Array
	private reads: Uint32Array
	private occupied: Uint8Array
	private depth = -1
	private final = false
	readonly capacity: number
	readonly bytes: number
	checked = 0; skipped = 0
	constructor(private keyBytes: number, budgetBytes: number) {
		if (!Number.isSafeInteger(keyBytes) || keyBytes < 1 || !Number.isSafeInteger(budgetBytes) || budgetBytes < 0 || budgetBytes > 1073741824) throw new Error('Invalid candidate cache budget')
		const maximum = Math.floor(budgetBytes / (keyBytes + 6))
		let capacity = maximum ? 1 : 0
		while (capacity && capacity * 2 <= maximum) capacity *= 2
		this.capacity = capacity
		this.keys = new Uint8Array(capacity * keyBytes); this.masks = new Uint8Array(capacity)
		this.reads = new Uint32Array(capacity); this.occupied = new Uint8Array(capacity)
		this.bytes = this.keys.byteLength + this.masks.byteLength + this.reads.byteLength + this.occupied.byteLength
	}
	beginDepth(depth: number, final = false) { if (depth !== this.depth || final !== this.final) { this.occupied.fill(0); this.depth = depth; this.final = final } }
	accept(state: Uint8Array, mask: number, reads: number) {
		if (state.length !== this.keyBytes || mask !== (mask & 255) || reads !== (reads >>> 0)) throw new Error('Invalid cached candidate')
		this.checked++
		if (!this.capacity) return true
		let hash = 2166136261
		for (const byte of state) hash = Math.imul(hash ^ byte, 16777619)
		if (!this.final) hash = Math.imul(hash ^ mask, 16777619)
		hash ^= hash >>> 16; hash = Math.imul(hash, 0x85ebca6b)
		hash ^= hash >>> 13; hash = Math.imul(hash, 0xc2b2ae35); hash ^= hash >>> 16
		const slot = hash & (this.capacity - 1), offset = slot * this.keyBytes
		let equal = this.occupied[slot] !== 0 && (this.final || this.masks[slot] === mask)
		for (let i = 0; equal && i < state.length; i++) equal = this.keys[offset + i] === state[i]
		if (equal) {
			const previousMask = this.masks[slot]
			const dominates = previousMask === mask ? this.reads[slot] <= reads :
				wireCounts[previousMask] < wireCounts[mask] || (wireCounts[previousMask] === wireCounts[mask] && this.reads[slot] < reads)
			// Equal-cost different masks remain eligible so SQL retains its tie choice.
			if (dominates) { this.skipped++; return false }
		}
		this.keys.set(state, offset); this.masks[slot] = mask; this.reads[slot] = reads; this.occupied[slot] = 1
		return true
	}
}
