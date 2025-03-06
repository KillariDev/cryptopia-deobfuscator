import { hashNumberArray } from './utils.js'

type CanonicalResult = {
	canonicalHash: string
	mapping: number[]
}

export function computeCanonicalForm(inputs: boolean[][], outputs: boolean[][]): CanonicalResult {
	const numVars = outputs[0].length
	const invariants: { invariant: number; index: number }[] = new Array(numVars)
	for (let i = 0; i < numVars; i++) {
		let invariant = 0
		for (let j = 0; j < outputs.length; j++) {
			invariant = (invariant << 1) | (inputs[j][i] ? 1 : 0)
			invariant = (invariant << 1) | (outputs[j][i] ? 1 : 0)
		}
		invariants[i] = { invariant, index: i }
	}
	invariants.sort((a, b) => a.invariant - b.invariant || a.index - b.index)

	const invariantValues: number[] = new Array(numVars)
	for (let i = 0; i < numVars; i++) {
		invariantValues[i] = invariants[i].invariant
	}

	const mapping: number[] = new Array(numVars)
	invariants.forEach((item, canonicalPos) => { mapping[item.index] = canonicalPos })
	return { canonicalHash: hashNumberArray(invariantValues), mapping }
}

export function getCanonicalHash(inputs: boolean[][], outputs: boolean[][]): string {
	const numVars = outputs[0].length
	const invariants: { invariant: number; index: number }[] = new Array(numVars)
	for (let i = 0; i < numVars; i++) {
		let invariant = 0
		for (let j = 0; j < outputs.length; j++) {
			invariant = (invariant << 1) | (inputs[j][i] ? 1 : 0)
			invariant = (invariant << 1) | (outputs[j][i] ? 1 : 0)
		}
		invariants[i] = { invariant, index: i }
	}
	invariants.sort((a, b) => a.invariant - b.invariant || a.index - b.index)

	const invariantValues: number[] = new Array(numVars)
	for (let i = 0; i < numVars; i++) {
		invariantValues[i] = invariants[i].invariant
	}
	return hashNumberArray(invariantValues)
}
