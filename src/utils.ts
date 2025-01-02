import * as fs from 'fs'
import { createHash } from 'crypto'
import { Gate } from './types.js'

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

export const evalGate = (controlFunction: number, a: boolean, b: boolean, originalOutput: boolean): boolean => {
	const normalEval = () => {
		switch(controlFunction) {
			case 0: return false
			case 1: return a && b
			case 2: return a && !b
			case 3: return a
			case 4: return !a && b
			case 5: return b
			case 6: return xor(a,b)
			case 7: return a || b
			case 8: return !(a || b)
			case 9: return (a && b) || ((!a) && (!b))
			case 10: return !b
			case 11: return (!b) || a
			case 12: return !a
			case 13: return (!a) || b
			case 14: return !(a && b)
			case 15: return true
			default: throw new Error(`invalid control function: ${ controlFunction }`)
		}
	}
	return xor(normalEval(), originalOutput)
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

export const simplifyGateOperatorIfGatesMatch = (gate: Gate) => {
	if (gate.a !== gate.b) return gate.gate_i
	switch(gate.gate_i) {
		case 0: return gate.gate_i // false
		case 1: return 3 // a && b -> "a"
		case 2: return 0 // a && !b -> "false"
		case 3: return gate.gate_i // a
		case 4: return 0 // !a && b -> "false"
		case 5: return gate.gate_i // b
		case 6: return 0 // xor(a,b) -> false
		case 7: return 3 // a || b -> "a"
		case 8: return 12 // !(a || b) -> !a"
		case 9: return 15 // (a && b) || ((!a) && (!b)) -> "true"
		case 10: return gate.gate_i // !b
		case 11: return 15 // (!b) || a -> "true"
		case 12: return gate.gate_i // !a
		case 13: return 15 // (!a) || -> "true"
		case 14: return 12 // !(a && b) -> "!a"
		case 15: return gate.gate_i // return true
		default: throw new Error(`invalid control function: ${ gate.gate_i }`)
	}
}

export const mapVariablesToIndexes = (gates: Gate[]) => {
	return [...new Set(gates.flatMap((gate) => getVars(gate)))].sort()
}
export const mapCircuit = (gates: Gate[], indexMapping: number[]) => {
	return gates.map((gate) => {
		const a = indexMapping.indexOf(gate.a)
		const b = indexMapping.indexOf(gate.b)
		const newGate = {
			a: a < 0 ? 0 : a,
			b: b < 0 ? 0 : b,
			target: indexMapping.indexOf(gate.target),
			gate_i: gate.gate_i
		}
		if (newGate.a === -1 || newGate.b === -1 || newGate.target === -1) {
			console.log(newGate)
			console.log(indexMapping)
			throw new Error('MAPPING FAILED!')
		}
		return newGate
	})
}
export const reverseMapCircuit = (mappedGates: Gate[], indexMapping: number[]) =>{
	return mappedGates.map((gate) => {
		const newGate = {
			a: indexMapping[gate.a] || 0, // if a variable is missing, its not a mandatory variable
			b: indexMapping[gate.b] || 0, // if a variable is missing, its not a mandatory variable
			target: indexMapping[gate.target],
			gate_i: gate.gate_i
		}
		if (newGate.a === undefined || newGate.b === undefined || newGate.target === undefined) {
			console.log(mappedGates)
			console.log(gate)
			console.log(newGate)
			console.log(indexMapping)
			throw new Error('REVERSE MAPPING FAILED!')
		}
		return newGate
	})
}

export const evalCircuit = (gates: Gate[], orinalInput: boolean[]) => {
	const input = orinalInput.slice()
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
	return combinations.flatMap((input) => (evalCircuit(gates, input)))
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

export function ioHash(mapping: boolean[]) {
	return hashBooleanArrays(mapping)
}

export const toBatches = (array: Gate[], batchSize: number): Gate[][] => {
	const batches = []
	for (let i = 0; i < array.length; i += batchSize) {
		batches.push(array.slice(i, i + batchSize))
	}
	return batches
}

export function areBooleanArraysEqual(arr1: boolean[], arr2: boolean[]): boolean {
	if (arr1.length !== arr2.length) {
		return false
	}
	for (let i = 0; i < arr1.length; i++) {
		if (arr1[i] !== arr2[i]) {
			return false
		}
	}
	return true
}
export function replace(array: any[], replacements: { start: number, end: number, replacement: any[] }[]): any[] {
	const result = [...array]
	replacements.sort((a, b) => a.start - b.start)
	replacements.forEach(({ start, end, replacement }) => {
		const deleteCount = end - start + 1
		result.splice(start, deleteCount, ...replacement)
		// Update indices to account for shifts
		replacements.forEach(r => {
			if (r.start > start) {
				r.start += replacement.length - deleteCount
				r.end += replacement.length - deleteCount
			}
		})
	})
	return result
}

export function generateRandomBooleanArray(N: number): boolean[] {
	const result: boolean[] = []
	for (let i = 0; i < N; i++) {
		result.push(Math.random() >= 0.5) // Random boolean (true/false)
	}
	return result
}

export const verifyCircuit = (oldGates: Gate[], newGates: Gate[], wires: number, testIterations: number) => {
	for (let i = 0; i < testIterations; i++) {
		const input = generateRandomBooleanArray(wires)
		const original = evalCircuit(oldGates, input)
		const optimized = evalCircuit(newGates, input)
		if (!areBooleanArraysEqual(original, optimized)) {
			console.log('CORRUPTION!')
			console.log('input', input.join(','))
			console.log('original output', original.join(','))
			console.log('optimized output', optimized.join(','))
			throw 'Circuit got corrupted!'
		}
	}
}

export const getRandomNumberInRange = (min: number, max: number): number => {
	return Math.floor(Math.random() * (max - min + 1)) + min
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
