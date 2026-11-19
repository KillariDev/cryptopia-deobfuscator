export class LimitedMap<K, V> {
	private map: Map<K, V>
	private limit: number

	constructor(limit: number, private policy: 'fifo' | 'lru' = 'fifo') {
		if (!Number.isSafeInteger(limit) || limit < 1) throw new Error('Limit must be a positive integer')
		this.map = new Map<K, V>(); this.limit = limit
	}

	set(key: K, value: V): K | undefined {
		let evicted: K | undefined
		if (this.map.has(key)) {
			if (this.policy === 'lru') this.map.delete(key)
		} else if (this.map.size >= this.limit) {
			evicted = this.map.keys().next().value!
			this.map.delete(evicted)
		}
		this.map.set(key, value)
		return evicted
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
