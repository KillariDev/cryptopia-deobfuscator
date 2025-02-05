export class LimitedMap<K, V> {
	private map: Map<K, V>
	private limit: number

	constructor(limit: number) {
		if (limit <= 0) {
			throw new Error('Limit must be greater than 0')
		}
		this.map = new Map<K, V>()
		this.limit = limit
	}

	set(key: K, value: V): void {
		if (this.map.size >= this.limit) {
			// Remove the oldest entry (first added key)
			const oldestKey = this.map.keys().next().value
			if (oldestKey !== undefined) this.map.delete(oldestKey)
		}
		this.map.set(key, value)
	}

	get(key: K): V | undefined {
		return this.map.get(key)
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
