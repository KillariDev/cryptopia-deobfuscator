const kMaxSize = Math.pow(2, 24)

export class BigMap<K, V> {
	private maps: Map<K, V>[]

	constructor(...parameters: ConstructorParameters<typeof Map<K, V>>) {
		this.maps = [new Map<K, V>(...parameters)]
	}

	set(key: K, value: V): this {
		const map = this.maps[this.maps.length - 1]

		if (map.size === kMaxSize) {
			this.maps.push(new Map<K, V>())
			return this.set(key, value)
		} else {
			map.set(key, value)
		}

		return this
	}

	has(key: K): boolean {
		return this._mapForKey(key) !== undefined
	}

	get(key: K): V | undefined {
		return this._valueForKey(key)
	}

	delete(key: K): boolean {
		const map = this._mapForKey(key)

		if (map !== undefined) {
			return map.delete(key)
		}

		return false
	}

	clear(): void {
		for (const map of this.maps) {
			map.clear()
		}
	}

	get size(): number {
		return this.maps.reduce((size, map) => size + map.size, 0)
	}

	forEach(callbackFn: (value: V, key: K, map: this) => void, thisArg?: any): void {
		for (const [key, value] of this) {
			callbackFn.call(thisArg, value, key, this)
		}
	}

	entries(): IterableIterator<[K, V]> {
		return this._iterator<[K, V]>('entries')
	}

	keys(): IterableIterator<K> {
		return this._iterator<K>('keys')
	}

	values(): IterableIterator<V> {
		return this._iterator<V>('values')
	}

	[Symbol.iterator](): IterableIterator<[K, V]> {
		return this.entries()
	}

	private _mapForKey(key: K): Map<K, V> | undefined {
		for (let i = this.maps.length - 1; i >= 0; i--) {
			if (this.maps[i].has(key)) {
				return this.maps[i]
			}
		}
	}

	private _valueForKey(key: K): V | undefined {
		for (let i = this.maps.length - 1; i >= 0; i--) {
			const value = this.maps[i].get(key)
			if (value !== undefined) {
				return value
			}
		}
	}

	private _iterator<T>(name: 'entries' | 'keys' | 'values'): IterableIterator<T> {
		const items = this.maps
		let index = 0
		let iterator = items[index][name]() as IterableIterator<T>

		return {
			next: (): IteratorResult<T> => {
				let result = iterator.next()

				if (result.done && index < items.length - 1) {
					index++
					iterator = items[index][name]() as IterableIterator<T>
					result = iterator.next()
				}

				return result
			},
			[Symbol.iterator]() {
				return this
			}
		} as IterableIterator<T>
	}
}

export class BigSet<T> {
	private sets: Set<T>[]

	constructor(...parameters: ConstructorParameters<typeof Set<T>>) {
		this.sets = [new Set<T>(...parameters)]
	}

	add(value: T): this {
		const set = this.sets[this.sets.length - 1]

		if (set.size === kMaxSize) {
			this.sets.push(new Set<T>())
			return this.add(value)
		} else {
			set.add(value)
		}

		return this
	}

	has(value: T): boolean {
		return this._setForKey(value) !== undefined
	}

	delete(value: T): boolean {
		const set = this._setForKey(value)
		return set !== undefined ? set.delete(value) : false
	}

	clear(): void {
		for (const set of this.sets) {
			set.clear()
		}
	}

	get size(): number {
		return this.sets.reduce((size, set) => size + set.size, 0)
	}

	forEach(callbackFn: (value: T, set: this) => void, thisArg?: any): void {
		for (const value of this) {
			callbackFn.call(thisArg, value, this)
		}
	}

	entries(): IterableIterator<[T, T]> {
		return this._iterator<[T, T]>('entries')
	}

	keys(): IterableIterator<T> {
		return this._iterator<T>('keys')
	}

	values(): IterableIterator<T> {
		return this._iterator<T>('values')
	}

	[Symbol.iterator](): IterableIterator<T> {
		return this.values()
	}

	private _setForKey(value: T): Set<T> | undefined {
		for (let i = this.sets.length - 1; i >= 0; i--) {
			if (this.sets[i].has(value)) {
				return this.sets[i]
			}
		}
	}

	private _iterator<T>(name: 'entries' | 'keys' | 'values'): IterableIterator<T> {
		const items = this.sets
		let index = 0
		let iterator = items[index][name]() as IterableIterator<T>

		return {
			next: (): IteratorResult<T> => {
				let result = iterator.next()

				if (result.done && index < items.length - 1) {
					index++
					iterator = items[index][name]() as IterableIterator<T>
					result = iterator.next()
				}

				return result
			},
			[Symbol.iterator]() {
				return this
			}
		} as IterableIterator<T>
	}
}
