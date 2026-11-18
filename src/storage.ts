import { config } from './config.js'
import { mkdirSync, writeFileSync } from 'fs'
import { basename, dirname, join } from 'path'
import { Gate } from './types.js'
import { convertToOriginal } from './utils.js'

export const outputPaths = (problemName: string, dataDirectory = config.files.dataDirectory) => {
	const name = basename(problemName)
	return {
		latest: `${problemName}-latest.json`,
		progress: (gateCount: number) => join(`${problemName}-progress`, `${name}.solved-${gateCount}.json`),
		worker: (index: number) => join(dataDirectory, config.files.workerDirectory, `${name}_worker${index}.json`),
	}
}

export const writeCircuit = (filename: string, wires: number, gates: Gate[]) => {
	writeCircuitCopies([filename], wires, gates)
}

export const prepareOutputDirectories = (dataDirectory = config.files.dataDirectory) => {
	mkdirSync(join(dataDirectory, config.files.workerDirectory), { recursive: true })
	mkdirSync(join(dataDirectory, config.files.progressDirectory), { recursive: true })
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

/** Serialized persistence advances the count only after verification and writes.
 * The count is rechecked when dequeued, so stale requests cannot regress disk. */
export class AsyncReductionCheckpoint {
 private savedCount:number
 private tail:Promise<unknown>=Promise.resolve()
 hasSaved=false
 constructor(initial:number,private persist:(gates:Gate[])=>Promise<void>){this.savedCount=initial}
 saveIfReduced(gates:Gate[]){
  const work=this.tail.then(async()=>{
   if(gates.length>=this.savedCount)return false
   await this.persist(gates);this.savedCount=gates.length;this.hasSaved=true;return true
  })
  this.tail=work.catch(()=>{})
  return work
 }
}
