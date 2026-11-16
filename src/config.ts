import { readFileSync } from 'fs'
import { fileURLToPath } from 'url'
import { resolve } from 'path'
import { isMainThread, workerData } from 'worker_threads'

export type RainbowTableSpec = { wires: number, gates: number }

export const defaults = {
	runtime: { heapMegabytes: 16384 },
	files: { dataDirectory: 'data', latestName: 'latest.json', workerDirectory: 'worker', progressDirectory: 'progress', databaseDirectory: '.' },
	workers: { maximum: 24, minimumChunkGates: 100, maximumChunkFraction: 0.5, jobsPerWorker: 4, jobSeconds: 30 },
	timing: { roundMinutes: 25, improvedRoundMinutes: 5, summarySeconds: 30, workerReportSeconds: 5, databaseLogSeconds: 60, standaloneSaveSeconds: 60 },
	logging: { verbose: false },
	validation: { checkpointInputs: 20, probabilisticInputs: 202, maximumWires: 64 },
	search: { probabilistic: true, variableElimination: true, exactMaximumWires: 7, subsetMinimum: 2, subsetMaximum: 199, sliceMinimum: 2, sliceMaximum: 199, maximumInnerChunks: 5, minimumInnerChunkGates: 200, workerShufflePasses: 200, roundShufflePasses: 2000, adaptive: true, explorationEvery: 5, searchArms: 16, prioritizeChangedWires: true, incrementalEvaluation: true, incrementalDependencies: true, prefixCacheBytes: 8388608, prefixStride: 16, normalizedCacheEntries: 10000, balancedWorkers: true },
	cache: { lookupEntries: 1000000, processedEntries: 1000000, shuffleEntries: 100000, subsetEntries: 100000, windowKeyBytes: 16777216 },
	database: { tables: [{ wires: 3, gates: 6 }, { wires: 4, gates: 5 }, { wires: 5, gates: 2 }], queryBatchSize: 900, lookupBatchMilliseconds: 0, insertBatchSize: 1000000, memoryMapBytes: 268435456, generationStates: 0, generationBatchRows: 3000, keepGenerationState: false, etaWindowSamples: 5, etaWarmupSamples: 3, etaSmoothing: 0.2 },
	synthesis: { templates: true, templateEntries: 10000, maximumWires: 3, maximumWindowGates: 8, maximumReplacementGates: 3, attemptEvery: 100, timeoutMs: 100, states: 2000, smt: false, meetInMiddle: false, equalitySaturation: false },
}
export type SolverConfig = typeof defaults

export function parseConfig(value: unknown): SolverConfig {
	if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Solver config must be a JSON object')
	const result = structuredClone(defaults)
	for (const [section, values] of Object.entries(value)) {
		if (!Object.prototype.hasOwnProperty.call(defaults, section)) throw new Error(`Unknown config section: ${section}`)
		if (!values || typeof values !== 'object' || Array.isArray(values)) throw new Error(`Invalid config section: ${section}`)
		for (const [key, setting] of Object.entries(values)) {
			const target = result[section as keyof SolverConfig] as Record<string, unknown>
			if (!Object.prototype.hasOwnProperty.call(target, key)) throw new Error(`Unknown config setting: ${section}.${key}`)
			if (section === 'database' && key === 'tables') {
				if (!Array.isArray(setting) || !setting.length) throw new Error('database.tables must be a nonempty array')
				const seen = new Set<string>()
				for (const table of setting) {
					if (!table || typeof table !== 'object' || Array.isArray(table) || Object.keys(table).sort().join(',') !== 'gates,wires' || !Number.isSafeInteger(table.wires) || table.wires < 1 || table.wires > 8 || !Number.isSafeInteger(table.gates) || table.gates < 1) throw new Error('Each database.tables entry needs wires (1-8) and a positive integer gates limit')
					const id = `${table.wires}:${table.gates}`
					if (seen.has(id)) throw new Error('Duplicate database.tables entry')
					seen.add(id)
				}
				target[key] = structuredClone(setting)
				continue
			}
			if (typeof setting !== typeof target[key]) throw new Error(`Invalid type for ${section}.${key}`)
			if (typeof setting === 'string' && !setting.trim()) throw new Error(`Empty config setting: ${section}.${key}`)
			if (typeof setting === 'number' && (!Number.isFinite(setting) || (setting < 0 || (setting === 0 && !['memoryMapBytes', 'generationStates', 'lookupBatchMilliseconds'].includes(key))) || (key !== 'maximumChunkFraction' && key !== 'etaSmoothing' && !key.endsWith('Minutes') && !key.endsWith('Seconds') && !Number.isSafeInteger(setting)))) throw new Error(`Invalid positive setting: ${section}.${key}`)
			target[key] = setting
		}
	}
	const { search, timing, database, validation, workers, files } = result
	if (database.etaSmoothing > 1 || database.etaWarmupSamples > database.etaWindowSamples) throw new Error('Invalid ETA smoothing settings')
	if (result.synthesis.maximumWires > 4) throw new Error('synthesis.maximumWires must be at most 4')
	if (search.subsetMinimum < 2 || search.sliceMinimum < 2 || search.subsetMaximum < search.subsetMinimum || search.sliceMaximum < search.sliceMinimum) throw new Error('Invalid search size ranges')
	if (search.exactMaximumWires > 16 || search.exactMaximumWires > validation.maximumWires || database.tables.some(table => table.wires > validation.maximumWires) || validation.maximumWires > 1024 || database.queryBatchSize > 900) throw new Error('Config exceeds supported wire or database batch limits')
	if (timing.improvedRoundMinutes > timing.roundMinutes || workers.maximumChunkFraction > 1) throw new Error('Invalid round timing or chunk fraction')
	for (const name of [files.latestName, files.workerDirectory, files.progressDirectory]) {
		if (name === '.' || name === '..' || /[\\/]/.test(name)) throw new Error('Output names must be single file or directory names')
	}
	return result
}

export const configPath = resolve(process.env.OPTIMIZER_CONFIG ?? fileURLToPath(new URL('../solver.config.json', import.meta.url)))
export const config: SolverConfig = !isMainThread && workerData?.solverConfig
	? parseConfig(workerData.solverConfig)
	: parseConfig(JSON.parse(readFileSync(configPath, 'utf8')))
