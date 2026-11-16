import { ChunkedSequence } from './chunked-sequence.js'
import { Gate } from './types.js'

export function patchCircuit<T>(values: T[], selected: number[], replacement: T[]) {
	const remove = new Set(selected)
	if (!remove.size || [...remove].some(i => !Number.isInteger(i) || i < 0 || i >= values.length)) throw new Error('Invalid circuit selection')
	const last = Math.max(...remove)
	const result: T[] = []
	let start = 0
	for (let i = 0; i < values.length; i++) {
		if (!remove.has(i)) result.push(values[i])
		if (i === last) { start = result.length; for (const value of replacement) result.push(value) }
	}
	return { values: result, start }
}

export class LazyCircuit {
	private parts: (Gate[] | ChunkedSequence<Gate>)[]
	private snapshot?: Gate[]
	private counts: number[]
	length: number
	constructor(parts: (Gate[] | ChunkedSequence<Gate>)[]) { this.parts = parts.slice(); this.counts = parts.map(part => part.length); this.length = parts.reduce((sum, gates) => sum + gates.length, 0) }
	update(index: number, gates: Gate[] | ChunkedSequence<Gate>) {
		this.length += gates.length - this.counts[index]
		this.parts[index] = gates; this.counts[index] = gates.length
		this.snapshot = undefined
	}
	materialize() { return this.snapshot ??= this.parts.flatMap(part => Array.isArray(part) ? part : part.toArray()) }
}
