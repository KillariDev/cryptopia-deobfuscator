import { isBetterCircuit } from './circuit-cost.js'
import { config } from './config.js'
import { mkdirSync, writeFileSync } from 'fs'
import { createHash } from 'node:crypto'
import { basename, dirname, join, resolve } from 'path'
import { withSQLiteLock } from './sql.js'
import { Gate } from './types.js'
import { convertToOriginal } from './utils.js'

export const outputPaths = (problemName: string, dataDirectory = config.files.dataDirectory) => {
	const name = basename(problemName)
	const defaultProgress = `${problemName}-progress`
	const puzzleKey = createHash('sha256').update(resolve(problemName)).digest('hex')
	const progressDirectory = config.files.progressDirectory === 'progress'
		? defaultProgress
		: join(dataDirectory, config.files.progressDirectory, puzzleKey)
	return {
		latest: `${problemName}-${config.files.latestName}`,
		progress: (gateCount: number) => join(progressDirectory, `${name}.solved-${gateCount}.json`),
		worker: (index: number) => join(dataDirectory, config.files.workerDirectory, puzzleKey, `${name}_worker${index}.json`),
		lock: join(defaultProgress, '.optimizer-lock.db'),
	}
}

/** SQLite releases the OS lock when the process exits, including after a crash. */
export async function withPuzzleLock<T>(problemName: string, run: () => Promise<T>): Promise<T> {
	const { lock } = outputPaths(problemName)
	mkdirSync(dirname(lock), { recursive: true })
	return withSQLiteLock(lock, `An optimizer is already running for ${problemName}.json`, run)
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
 * The best circuit is rechecked when dequeued, so stale requests cannot regress disk. */
export class AsyncReductionCheckpoint {
	private tail: Promise<unknown> = Promise.resolve()
	hasSaved = false
	constructor(private best: Gate[] | number, private persist: (gates: Gate[]) => Promise<void>) {}

	saveIfReduced(gates: Gate[]) {
		const work = this.tail.then(async () => {
			const better = typeof this.best === 'number' ? gates.length < this.best : isBetterCircuit(gates, this.best)
			if (!better) return false
			await this.persist(gates)
			this.best = gates
			this.hasSaved = true
			return true
		})
		this.tail = work.catch(() => {})
		return work
	}
}
