import * as fs from 'fs'
import { createHash } from 'crypto'
import { DependencyNode, Gate } from './types.js'
import { createDependencyGraph } from './lineswapper.js'

export const readJsonFile = (filePath: string): any => {
	try {
		// Read the file contents as a string
		const fileContents = fs.readFileSync(filePath, 'utf-8')

		// Parse the JSON string into an object
		return JSON.parse(fileContents)
	} catch (error) {
		console.error(`Error reading or parsing JSON file at ${filePath}:`, error)
		return null
	}
}

export const writeDictionaryToFile = (dict: object, path: string) => {
	const jsonData = JSON.stringify(dict, null, 2) // Format JSON with 2 spaces
	fs.writeFileSync(path, jsonData, 'utf8')
}

export const getControlFunc = (controlFunction: number) => {
	switch(controlFunction) {
		case -1: return 'CREATE'
		case 0: return 'FALSE'
		case 1: return 'a & b'
		case 2: return 'a & !b'
		case 3: return 'a'
		case 4: return '!a & b'
		case 5: return 'b'
		case 6: return 'a ^ b'
		case 7: return 'a | b'
		case 8: return '!(a | b)'
		case 9: return '(a & b) | (!a & !b)'
		case 10: return '!b'
		case 11: return '!b | a'
		case 12: return '!a'
		case 13: return '!a | b'
		case 14: return '!(a & b)'
		case 15: return 'TRUE'
		default: throw new Error(`invalid control function: ${ controlFunction }`)
	}
}

export const xor = (a: boolean, b: boolean) => {
	return ( a || b ) && !( a && b ) 
}

const lookupTable: boolean[][][] = Array.from({ length: 16 }, (_, controlFunction) => {
	return [false, true].map(a => {
		return [false, true].map(b => {
			switch (controlFunction) {
				case 0: return false
				case 1: return a && b
				case 2: return a && !b
				case 3: return a
				case 4: return !a && b
				case 5: return b
				case 6: return xor(a, b)
				case 7: return a || b
				case 8: return !(a || b)
				case 9: return (a && b) || (!a && !b)
				case 10: return !b
				case 11: return (!b) || a
				case 12: return !a
				case 13: return (!a) || b
				case 14: return !(a && b)
				case 15: return true
				default: throw new Error(`invalid control function: ${ controlFunction }`)
			}
		})
	})
})

export const evalGate = (controlFunction: number, a: boolean, b: boolean, originalOutput: boolean): boolean => {
	return xor(lookupTable[controlFunction][a ? 1 : 0][b ? 1 : 0], originalOutput)
}

export const getUniqueVars = (gates: Gate[]) => Array.from(new Set(gates.flatMap((gate) => getVars(gate))))

export const getVars = (gate: Gate) => {
	switch(gate.gate_i) {
		case 0: return [gate.target] // return false 
		case 1: return [gate.target, gate.a, gate.b] // return a && b
		case 2: return [gate.target, gate.a, gate.b] // return a && !b
		case 3: return [gate.target, gate.a] // return a//
		case 4: return [gate.target, gate.a, gate.b] // return !a && b
		case 5: return [gate.target, gate.b] // return b
		case 6: return [gate.target, gate.a, gate.b] // return xor(a,b)
		case 7: return [gate.target, gate.a, gate.b] // return a || b
		case 8: return [gate.target, gate.a, gate.b] // return !(a || b)
		case 9: return [gate.target, gate.a, gate.b] // return (a && b) || ((!a) && (!b))
		case 10: return [gate.target, gate.b] // return !b
		case 11: return [gate.target, gate.a, gate.b] // return (!b) || a
		case 12: return [gate.target, gate.a] // return !a
		case 13: return [gate.target, gate.a, gate.b] // return (!a) || b
		case 14: return [gate.target, gate.a, gate.b] // return !(a && b)
		case 15: return [gate.target] // return true
		default: throw new Error(`invalid control function: ${ gate.gate_i }`)
	}
}

export const simplifyGate = (gate: Gate): Gate => {
	if (gate.a !== gate.b) {
		if (gate.a > gate.b) {
			const swapped = {...gate, a: gate.b, b: gate.a }
			switch(gate.gate_i) {
				case 0: return swapped // false
				case 1: return swapped // a && b
				case 2: return {...swapped, gate_i: 4 } // a && !b
				case 3: return {...swapped, gate_i: 5 } // a
				case 4: return {...swapped, gate_i: 2 } // !a && b
				case 5: return {...swapped, gate_i: 3 } // b
				case 6: return swapped // xor(a,b)
				case 7: return swapped // a || b
				case 8: return swapped // !(a || b)
				case 9: return swapped // (a && b) || ((!a) && (!b))
				case 10: return {...swapped, gate_i: 12 } // !b
				case 11: return {...swapped, gate_i: 13 } // (!b) || a
				case 12: return {...swapped, gate_i: 10 } // !a
				case 13: return {...swapped, gate_i: 11 } // (!a) || b
				case 14: return swapped // !(a && b)
				case 15: return swapped // return true
				default: throw new Error(`invalid control function: ${ gate.gate_i }`)
			}
		}
		return gate
	}
	switch(gate.gate_i) {
		case 0: return gate // false
		case 1: return {...gate, gate_i: 3 } // a && b -> "a"
		case 2: return {...gate, gate_i: 0 } // a && !b -> "false"
		case 3: return gate // a
		case 4: return {...gate, gate_i: 0 } // !a && b -> "false"
		case 5: return gate // b
		case 6: return {...gate, gate_i: 0 } // xor(a,b) -> false
		case 7: return {...gate, gate_i: 3 } // a || b -> "a"
		case 8: return {...gate, gate_i: 12 } // !(a || b) -> !a"
		case 9: return {...gate, gate_i: 15 } // (a && b) || ((!a) && (!b)) -> "true"
		case 10: return gate // !b
		case 11: return {...gate, gate_i: 15 } // (!b) || a -> "true"
		case 12: return gate // !a
		case 13: return {...gate, gate_i: 15 } // (!a) || b || -> "true"
		case 14: return {...gate, gate_i: 12 } // !(a && b) -> "!a"
		case 15: return gate // return true
		default: throw new Error(`invalid control function: ${ gate.gate_i }`)
	}
}

export const mapVariablesToIndexes = (gates: Gate[]) => {
	return [...new Set(gates.flatMap((gate) => getVars(gate)))].sort((a, b) => a - b)
}
export const mapCircuit = (gates: Gate[], indexMapping: number[]) => {
	const inverse = new Map(indexMapping.map((wire, index) => [wire, index]))
	return gates.map((gate) => {
		const a = inverse.get(gate.a) ?? -1
		const b = inverse.get(gate.b) ?? -1
		const newGate = {
			a: a < 0 ? 0 : a,
			b: b < 0 ? 0 : b,
			target: inverse.get(gate.target) ?? -1,
			gate_i: gate.gate_i
		}
		return newGate
	})
}
export const reverseMapCircuit = (mappedGates: Gate[], indexMapping: number[]): Gate[] =>{
	return mappedGates.map((gate) => {
		const newGate = {
			a: indexMapping[gate.a] || 0, // if a variable is missing, its not a mandatory variable
			b: indexMapping[gate.b] || 0, // if a variable is missing, its not a mandatory variable
			target: indexMapping[gate.target],
			gate_i: gate.gate_i
		}
		return newGate
	})
}

export const evalCircuit = (gates: Gate[], orginalInput: boolean[]) => {
	const input = orginalInput.slice()
	gates.forEach((gate) => {
		input[gate.target] = evalGate(
			gate.gate_i,
			input[gate.a],
			input[gate.b],
			input[gate.target]
		)
	})
	return input
}

export const placeVariables = (a: string, b: string, controlFunc: string) => {
	const regex = /a|b/g
	return controlFunc.replace(regex, match => match === 'a' ? a : b)
}

export function convertToOriginal(wires: number, gates: Gate[]): string {
	return JSON.stringify({
		wire_count: wires,
		gate_count: gates.length,
		gates: gates.map((x) => [x.a, x.b, x.target, x.gate_i])
	})
}

export function generateCombinations(arrayLength: number): boolean[][] {
	const totalCombinations = 1 << arrayLength // 2^arrayLength
	const combinations: boolean[][] = Array.from({ length: totalCombinations }, (_, i) => {
		const combination = new Array(arrayLength)
		for (let j = 0; j < arrayLength; j++) {
			combination[j] = (i & (1 << j)) !== 0 // Determine the j-th bit
		}
		return combination
	})
	return combinations
}

export function calculateAllOutputsArray(gates: Gate[], combinations: boolean[][]) {
	if (combinations.length === 0) return []
	const wires = combinations[0].length
	const outputs: boolean[] = []
	// One bit per input, up to 32 inputs at once. Preserve input-major order
	// and the existing byte-array hashing format used by the SQLite table.
	for (let offset = 0; offset < combinations.length; offset += 32) {
		const count = Math.min(32, combinations.length - offset)
		const values = new Int32Array(wires)
		for (let bit = 0; bit < count; bit++) {
			for (let wire = 0; wire < wires; wire++) {
				if (combinations[offset + bit][wire]) values[wire] |= 1 << bit
			}
		}
		for (const gate of gates) {
			const a = values[gate.a], b = values[gate.b]
			const f = gate.gate_i
			if (f < 0 || f > 15) throw new Error(`invalid control function: ${f}`)
			// Function codes encode their four truth-table entries in reverse order.
			const control = ((f & 8) ? ~a & ~b : 0)
				| ((f & 4) ? ~a & b : 0)
				| ((f & 2) ? a & ~b : 0)
				| ((f & 1) ? a & b : 0)
			values[gate.target] ^= control
		}
		for (let bit = 0; bit < count; bit++) {
			for (let wire = 0; wire < wires; wire++) outputs.push(((values[wire] >>> bit) & 1) !== 0)
		}
	}
	return outputs
}
export function calculateAllOutputsArrayNonFlat(gates: Gate[], combinations: boolean[][]) {
	return combinations.map((input) => (evalCircuit(gates, input)))
}

export const hashBooleanArrays = (array: boolean[]): string => {
	const buffer = Buffer.alloc(array.length)
	let offset = 0
	for (const bool of array) {
		buffer[offset++] = bool ? 1 : 0
	}

	// Create hash directly from the buffer
	const hash = createHash('sha256')
	hash.update(buffer)
	return hash.digest('hex')
}

export const hashGates = (gates: Gate[]): string => {
	// Exact structural key: shuffle-cache hits authorize a circuit rewrite.
	return gates.map(({ a, b, target, gate_i }) => `${a},${b},${target},${gate_i}`).join(';')
}

export const hashGatesRange = (gates: Gate[], start: number, end:number): string => {
	let hash = 0
	for (let i = start; i<end; i++) {
		const { a, b, target, gate_i } = gates[i]
		hash = (hash * 31 + a) & 0xffffffff
		hash = (hash * 31 + b) & 0xffffffff
		hash = (hash * 31 + target) & 0xffffffff
		hash = (hash * 31 + gate_i) & 0xffffffff
	}
	return hash.toString(16)
}

export const hashNumberArray = (array: number[]): string => {
	// Allocate a buffer large enough to hold the numbers (assuming 4 bytes per number)
	const buffer = Buffer.alloc(array.length * 4)  // 4 bytes per number
	let offset = 0
	// Write each number as a 4-byte integer
	for (const n of array) {
		buffer.writeInt32BE(n, offset)  // Write a 32-bit integer in big-endian format
		offset += 4
	}
	// Create the SHA-256 hash
	const hash = createHash('sha256')
	hash.update(buffer)
	return hash.digest('hex')
}

export function ioHash(mapping: boolean[]) {
	const bytes = Buffer.alloc(Math.ceil(mapping.length / 8))
	mapping.forEach((value, i) => { if (value) bytes[i >>> 3] |= 1 << (i & 7) })
	return bytes.toString('hex')
}

export const toBatches = (array: Gate[], batchSize: number): Gate[][] => {
	const batches = []
	for (let i = 0; i < array.length; i += batchSize) {
		batches.push(array.slice(i, i + batchSize))
	}
	return batches
}

export function areBooleanArraysEqual(arr1: boolean[], arr2: boolean[]): boolean {
	if (arr1.length !== arr2.length) return false
	for (let i = 0; i < arr1.length; i++) {
		if (arr1[i] !== arr2[i]) return false
	}
	return true
}

export function replace(array: any[], replacements: { start: number, end: number, replacement: any[] }[]): any[] {
	const result = [...array]
	replacements.sort((a, b) => b.start - a.start)
	replacements.forEach(({ start, end, replacement }) => {
		result.splice(start, end - start + 1, ...replacement)
	})
	return result
}

export function remove(array: any[], deleteIndexes: number[]): any[] {
	const toRemove = new Set(deleteIndexes)
	return array.filter((_, index) => !toRemove.has(index))
}

export function generateRandomBooleanArray(N: number): boolean[] {
	const result: boolean[] = []
	for (let i = 0; i < N; i++) {
		result.push(Math.random() >= 0.5) // Random boolean (true/false)
	}
	return result
}

export function generateNRandomBooleanArray(rows: number, columns: number): boolean[][] {
	const result: boolean[][] = []
	for (let r = 0; r < rows; r++) {
		result.push(generateRandomBooleanArray(columns))
	}
	return result
}

export const verifyCircuit = (oldGates: Gate[], newGates: Gate[], wires: number, testIterations: number) => {
	for (let i = 0; i < testIterations; i++) {
		const input = generateRandomBooleanArray(wires)
		const original = evalCircuit(oldGates, input)
		const optimized = evalCircuit(newGates, input)
		if (!areBooleanArraysEqual(original, optimized)) {
			console.log('input', input.join(','))
			console.log('CORRUPTION!')
			console.log('oldsize', oldGates.length)
			console.log('newsize', newGates.length)
			input.forEach((_,index) => {
				if (original[index] !== optimized[index]) {
					console.log(`v${index} differs`)
				}
			})
			throw 'Circuit got corrupted!'
		}
	}
}

export const getRandomNumberInRange = (min: number, max: number): number => {
	return Math.floor(Math.random() * (max - min)) + min
}

export const gateToText = (gate: Gate) => {
	const aName = `v${ gate.a }`
	const bName = `v${ gate.b }`
	const targetName = `v${ gate.target }`
	const control = getControlFunc(gate.gate_i)
	return `${ targetName} ^= ${ placeVariables(aName, bName, control) }`
}

export const gatesToText = (gates: Gate[]) => {
	return gates.map((gate) => gateToText(gate)).join('\n')
}

export function assertNever(value: never): never {
	throw new Error(`Unhandled discriminated union member: ${JSON.stringify(value)}`)
}

class SortedArray {
	private elements: number[] = []

	// Add one or multiple numbers to the sorted array
	add(nums: number | number[]): void {
		if (!Array.isArray(nums)) {
			nums = [nums]
		}

		// Deduplicate and filter out existing elements
		const uniqueNums = [...new Set(nums)].filter(num => !this.contains(num))

		// Merge the new numbers into the sorted array
		for (const num of uniqueNums) {
			let left = 0
			let right = this.elements.length

			// Binary search for the correct position
			while (left < right) {
				const mid = Math.floor((left + right) / 2)
				if (this.elements[mid] < num) {
					left = mid + 1
				} else {
					right = mid
				}
			}

			// Insert the number at the correct position
			this.elements.splice(left, 0, num)
		}
	}

	// Check if the array contains a number
	private contains(num: number): boolean {
		let left = 0
		let right = this.elements.length - 1

		// Binary search for the number
		while (left <= right) {
			const mid = Math.floor((left + right) / 2)
			if (this.elements[mid] === num) {
				return true
			} else if (this.elements[mid] < num) {
				left = mid + 1
			} else {
				right = mid - 1
			}
		}

		return false
	}

	// Remove and return the smallest element
	popMin(): number | undefined {
		return this.elements.shift()
	}

	// Remove and return the largest element
	popMax(): number | undefined {
		return this.elements.pop()
	}

	// Get the sorted elements (read-only)
	get values(): readonly number[] {
		return this.elements
	}
}


export type WireAccessIndex = { accesses: Map<number, number[]>, writes: Map<number, number[]> }
export function appendWireAccess(index: Map<number, number[]>, wire: number, id: number) {
	const list = index.get(wire)
	if (!list) index.set(wire, [id])
	else if (list[list.length - 1] !== id) list.push(id)
}

export function indexWireAccesses(gates: Gate[]): WireAccessIndex {
	const accesses = new Map<number, number[]>(), writes = new Map<number, number[]>()
	gates.forEach((gate, line) => {
		for (const wire of getVars(gate)) appendWireAccess(accesses, wire, line)
		appendWireAccess(writes, gate.target, line)
	})
	return { accesses, writes }
}

export function wireAccessLowerBound(lines: readonly number[], before: number, positionOf?: (id: number) => number) {
	let low = 0, high = lines.length
	while (low < high) {
		const mid = (low + high) >>> 1
		const position = positionOf ? positionOf(lines[mid]) : lines[mid]
		if (position < before) low = mid + 1
		else high = mid
	}
	return low
}

// Only the last conflicting future line is consumed by subset selection.
function lastUnselected(lines: number[] = [], after: number, before: number, subset: Set<number>) {
	const low = wireAccessLowerBound(lines, before)
	for (let i = low - 1; i >= 0 && lines[i] > after; i--) {
		if (!subset.has(lines[i])) return lines[i]
	}
	return -1
}

export type GateSequence = Gate[] | { length: number, at(index: number): Gate, toArray(): Gate[] }
const gateAt = (gates: Gate[] | { at(index: number): Gate }, index: number) => Array.isArray(gates) ? gates[index] : gates.at(index)
const gateArray = (gates: GateSequence) => Array.isArray(gates) ? gates : gates.toArray()

export type DependencyQueries = {
	past(line: number): number[]
	followers(line: number, before: number, selected: Set<number>): number[]
	lastConflict(line: number, before: number, selected: Set<number>): number
}

export function dependencyQueries(dependantMap: Map<number, number[]>, nodes: DependencyNode[], gates: Gate[] | { at(index: number): Gate }, access: WireAccessIndex): DependencyQueries {
	return {
		past: line => nodes[line].dependOnPastLines,
		followers: (line, before, selected) => (dependantMap.get(line) ?? []).filter(next => next < before && !selected.has(next)),
		lastConflict: (line, before, selected) => {
			const [target, ...controls] = getVars(gateAt(gates, line))
			let last = lastUnselected(access.accesses.get(target), line, before, selected)
			for (const wire of controls) last = Math.max(last, lastUnselected(access.writes.get(wire), line, before, selected))
			return last
		},
	}
}

export const dependencyGraphToMap = (nodes: DependencyNode[]) => {
	const dependantMap = new Map<number, number[]>()
	for (const node of nodes) {
		for (const depend of node.dependOnPastLines) {
			const list = dependantMap.get(depend)
			if (list) list.push(node.lineNumber)
			else dependantMap.set(depend, [node.lineNumber])
		}
	}
	return dependantMap
}

export type DependencyContext = { nodes: DependencyNode[], dependantMap: Map<number, number[]>, access: WireAccessIndex }

export function* findConvexSubsets(N: number, gates: GateSequence, preferredWires?: Set<number>, context?: DependencyContext, seeds: number[] = [], stopped: () => boolean = () => false): Generator<number[]> {
	//yield Array.from(Array(gates.length).keys()) // start with current order
	if (N === 0 || stopped()) return
	const nodes = context?.nodes ?? createDependencyGraph(gateArray(gates))
	const dependantMap = context?.dependantMap ?? dependencyGraphToMap(nodes)
	const access = context?.access ?? indexWireAccesses(gateArray(gates))
	const visited = new Set<number>()
	for (const seed of seeds) {
		if (stopped()) return
		if (!Number.isInteger(seed) || seed < 0 || seed >= nodes.length || visited.has(seed)) continue
		visited.add(seed)
		const subset = dependencySort(dependantMap, nodes[seed], N, nodes, gates, access, stopped)
		if (subset.length >= N) yield subset
	}

	function shuffle(array: DependencyNode[]) {
		let currentIndex = array.length;
	  
		// While there remain elements to shuffle...
		while (currentIndex != 0) {
	  
		  // Pick a remaining element...
		  let randomIndex = Math.floor(Math.random() * currentIndex);
		  currentIndex--;
	  
		  // And swap it with the current element.
		  [array[currentIndex], array[randomIndex]] = [
			array[randomIndex], array[currentIndex]];
		}
		return array
	  }

	const shuffledNodes = shuffle(nodes.slice())
	const preferred: DependencyNode[] = []
	if (preferredWires?.size) {
		// Stable partition preserves shuffled order within both groups.
		let remaining = 0
		for (const node of shuffledNodes) {
			if (stopped()) return
			if (getVars(gateAt(gates, node.lineNumber)).some(wire => preferredWires.has(wire))) preferred.push(node)
			else shuffledNodes[remaining++] = node
		}
		shuffledNodes.length = remaining
	}
	for (const group of [preferred, shuffledNodes]) for (const node of group) {
		if (stopped()) return
		if (visited.has(node.lineNumber)) continue
		const currentSubset = dependencySort(dependantMap, node, N, nodes, gates, access, stopped)
		if (currentSubset.length >= N) yield currentSubset
	}
}

export const dependencySort = (dependantMap: Map<number, number[]>, node: DependencyNode, maxLength: number, nodes: DependencyNode[], gates: GateSequence, access = indexWireAccesses(gateArray(gates)), stopped: () => boolean = () => false) =>
	selectDependencyRegion(dependencyQueries(dependantMap, nodes, gates, access), node.lineNumber, maxLength, stopped)

export function selectDependencyRegion(queries: DependencyQueries, anchor: number, maxLength: number, stopped: () => boolean = () => false) {
	const currentSubset = [anchor]
	const selected = new Set(currentSubset)
	const pending = new SortedArray()
	pending.add(queries.past(anchor))
	while (!stopped()) {
		const candidate = pending.popMin()
		if (candidate === undefined) return currentSubset.reverse()
		if (selected.has(candidate)) continue
		let line = candidate
		while (true) {
			if (stopped()) return []
			const conflict = queries.lastConflict(line, anchor, selected)
			if (conflict === -1) break
			line = conflict
		}
		const followers = queries.followers(line, anchor, selected)
		if (followers.length) {
			pending.add([candidate, ...followers])
			continue
		}
		if (line !== candidate) pending.add(candidate)
		currentSubset.push(line)
		if (currentSubset.length >= maxLength) return currentSubset.reverse()
		selected.add(line)
		pending.add(queries.past(line).filter(previous => !selected.has(previous)))
	}
	return []
}

export const randomOrder = (nMax: number): number[] => {
	const arr: number[] = Array.from({ length: nMax }, (_, i) => i)
	for (let i = nMax - 1; i > 0; i--) {
		const j: number = Math.floor(Math.random() * (i + 1));
		[arr[i], arr[j]] = [arr[j], arr[i]]
	}
	return arr
}

export function logTimed(...args: any[]) {
	const date = new Date()
	const year = date.getFullYear()
	const month = String(date.getMonth() + 1).padStart(2, '0')
	const day = String(date.getDate()).padStart(2, '0')
	const hour = String(date.getHours()).padStart(2, '0')
	const minute = String(date.getMinutes()).padStart(2, '0')
	const second = String(date.getSeconds()).padStart(2, '0')
	const timestamp = `${ year }-${ month }-${ day } ${ hour }:${ minute }:${ second }`
	console.log(`[${ timestamp }]`, ...args)
}

export function chunkArray<T>(arr: T[], numChunks: number): T[][] {
	const chunkSize = Math.ceil(arr.length / numChunks)
	const chunks: T[][] = []
	for (let i = 0; i < arr.length; i += chunkSize) {
		chunks.push(arr.slice(i, i + chunkSize))
	}
	return chunks
}

export const isReplacementSimpler = (replacement: Gate[], oldGates: Gate[]) => {
	if (replacement.length !== oldGates.length) return replacement.length < oldGates.length
	const uniqueR = getUniqueVars(replacement).length
	const uniqueO = getUniqueVars(oldGates).length
	if (uniqueR !== uniqueO) return uniqueR < uniqueO
	return replacement.flatMap(x => getVars(x)).length < oldGates.flatMap(x => getVars(x)).length
}
