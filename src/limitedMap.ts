export class LimitedMap<K, V> {
	private map: Map<K, V>
	private limit: number
	private evictionCursor?: ReturnType<Map<K, V>['keys']>

	constructor(limit: number, private policy: 'fifo' | 'lru' = 'fifo') {
		if (!Number.isSafeInteger(limit) || limit < 1) throw new Error('Limit must be a positive integer')
		this.map = new Map<K, V>(); this.limit = limit
	}

	set(key: K, value: V): K | undefined {
		let evicted: K | undefined
		if (this.map.has(key)) {
			if (this.policy === 'lru') this.map.delete(key)
		} else if (this.map.size >= this.limit) {
			evicted = this.evictOldest()
		}
		this.map.set(key, value)
		return evicted
	}

	evictOldest(): K | undefined {
		if (!this.map.size) return undefined
		// A live iterator skips earlier deletions without restarting at the front.
		const cursor = this.evictionCursor ??= this.map.keys()
		const { value: oldest, done } = cursor.next()
		if (done) return undefined
		this.map.delete(oldest)
		return oldest
	}

	get(key: K): V | undefined {
		const value = this.map.get(key)
		if (this.policy === 'lru' && this.map.has(key)) { this.map.delete(key); this.map.set(key, value!) }
		return value
	}


	has(key: K): boolean {
		return this.map.has(key)
	}

	delete(key: K): boolean {
		return this.map.delete(key)
	}

	size(): number {
		return this.map.size
	}

	clear(): void {
		this.map.clear()
		this.evictionCursor = undefined
	}

	entries(): IterableIterator<[K, V]> {
		return this.map.entries()
	}

	keys(): IterableIterator<K> {
		return this.map.keys()
	}

	values(): IterableIterator<V> {
		return this.map.values()
	}
}
