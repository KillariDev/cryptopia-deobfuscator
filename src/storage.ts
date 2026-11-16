import { mkdirSync, writeFileSync } from 'fs'
import { basename, dirname, join } from 'path'
import { Gate } from './types.js'
import { convertToOriginal } from './utils.js'

export const outputPaths = (problemName: string, dataDirectory = 'data') => {
	const name = basename(problemName)
	return {
		latest: join(dataDirectory, 'latest.json'),
		progress: (gateCount: number) => join(dataDirectory, 'progress', `${name}.solved-${gateCount}.json`),
		worker: (index: number) => join(dataDirectory, 'worker', `${name}_worker${index}.json`),
	}
}

export const writeCircuit = (filename: string, wires: number, gates: Gate[]) => {
	writeCircuitCopies([filename], wires, gates)
}

export const prepareOutputDirectories = (dataDirectory = 'data') => {
	mkdirSync(join(dataDirectory, 'worker'), { recursive: true })
	mkdirSync(join(dataDirectory, 'progress'), { recursive: true })
}

export const writeCircuitCopies = (filenames: string[], wires: number, gates: Gate[]) => {
	const payload = convertToOriginal(wires, gates)
	for (const filename of new Set(filenames)) {
		mkdirSync(dirname(filename), { recursive: true })
		writeFileSync(filename, payload, 'utf8')
	}
}

// Advance the saved count only after verification and both writes succeed.
export class ReductionCheckpoint {
	private savedCount: number
	hasSaved = false
	constructor(initialCount: number, private persist: (gates: Gate[]) => void) { this.savedCount = initialCount }
	saveIfReduced(gates: Gate[]) {
		if (gates.length >= this.savedCount) return false
		this.persist(gates)
		this.savedCount = gates.length
		this.hasSaved = true
		return true
	}
}
