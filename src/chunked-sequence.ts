type Chunk<T> = { values: T[], start: number }
/** Copy edited chunks, retain untouched ones, and index unique stable IDs locally. */
export class ChunkedSequence<T> {
	private chunks: Chunk<T>[] = []
	private handles = new Map<T, { chunk: Chunk<T>, offset: number }>()
	private snapshot?: T[]
	length = 0
	constructor(values: T[], private chunkSize = 128, private indexed = false) {
		if (indexed && new Set(values).size !== values.length) throw new Error('Duplicate stable circuit ID')
		if (!Number.isSafeInteger(chunkSize) || chunkSize < 1) throw new Error('Invalid circuit chunk size')
		for (let i = 0; i < values.length; i += chunkSize) this.chunks.push(this.make(values.slice(i, i + chunkSize)))
		this.reindexChunks()
	}
	private make(values: T[]): Chunk<T> {
		const chunk = { values, start: 0 }
		if (this.indexed) for (const [offset, value] of values.entries()) this.handles.set(value, { chunk, offset })
		return chunk
	}
	private reindexChunks() {
		let start = 0
		for (const chunk of this.chunks) { chunk.start = start; start += chunk.values.length }
		this.length = start; this.snapshot = undefined
	}
	private locate(index: number) {
		if (!Number.isInteger(index) || index < 0 || index >= this.length) throw new Error('Circuit index out of bounds')
		let low = 0, high = this.chunks.length
		while (low < high) { const middle = (low + high) >>> 1; if (this.chunks[middle].start <= index) low = middle + 1; else high = middle }
		return this.chunks[low - 1]
	}
	at(index: number) { const chunk = this.locate(index); return chunk.values[index - chunk.start] }
	indexOf(value: T): number | undefined {
		if (!this.indexed) throw new Error('Sequence has no stable ID index')
		const handle = this.handles.get(value)
		return handle ? handle.chunk.start + handle.offset : undefined
	}
	* [Symbol.iterator]() { for (const chunk of this.chunks) yield* chunk.values }
	toArray() { return this.snapshot ??= [...this] }
	replace(selected: number[], replacement: T[]) {
		const indices = [...new Set(selected)].sort((a, b) => a - b)
		if (!indices.length || indices.some(i => !Number.isInteger(i) || i < 0 || i >= this.length)) throw new Error('Invalid circuit selection')
		const last = indices[indices.length - 1], start = last + 1 - indices.length
		if (this.indexed) {
			const removed = new Set(indices.map(i => this.at(i))), incoming = new Set<T>()
			for (const value of replacement) {
				if (incoming.has(value) || this.handles.has(value) && !removed.has(value)) throw new Error('Duplicate stable circuit ID')
				incoming.add(value)
			}
			for (const value of removed) this.handles.delete(value)
		}
		const next: Chunk<T>[] = []
		const append = (chunk: Chunk<T>) => {
			if (!chunk.values.length) return
			const previous = next[next.length - 1]
			if (previous && previous.values.length + chunk.values.length <= this.chunkSize) next[next.length - 1] = this.make([...previous.values, ...chunk.values])
			else next.push(chunk)
		}
		let cursor = 0
		for (const chunk of this.chunks) {
			const end = chunk.start + chunk.values.length
			if (cursor >= indices.length || indices[cursor] >= end) { append(chunk); continue }
			const values: T[] = []
			for (let offset = 0; offset < chunk.values.length; offset++) {
				const index = chunk.start + offset
				if (index === indices[cursor]) cursor++
				else values.push(chunk.values[offset])
				if (index === last) for (const value of replacement) values.push(value)
			}
			for (let i = 0; i < values.length; i += this.chunkSize) append(this.make(values.slice(i, i + this.chunkSize)))
		}
		this.chunks = next; this.reindexChunks()
		return start
	}
}
