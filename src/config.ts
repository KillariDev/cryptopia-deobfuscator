import { readFileSync } from 'fs'
import { fileURLToPath } from 'url'
import { resolve } from 'path'
import { isMainThread, workerData } from 'worker_threads'

export type RainbowTableSpec = { wires: number, gates: number }

export const defaults = {
	runtime: { heapMegabytes: 16384 },
	files: { dataDirectory: 'data', latestName: 'latest.json', workerDirectory: 'worker', progressDirectory: 'progress', databaseDirectory: '.' },
	workers: { maximum: 24, minimumChunkGates: 100, maximumChunkFraction: 0.5, jobsPerWorker: 4, jobSeconds: 30, adaptiveConcurrency: true, initialConcurrency: 4, concurrencySampleRounds: 2, concurrencyDatabaseFraction: 0.6, concurrencyRateTolerance: 0.05, memoryBudgetMegabytes: 8192, shareTemplates: true, sharedTemplateSeconds: 15, sharedTemplateEntries: 64, sharedTemplateBatch: 16 },
	timing: { roundMinutes: 25, improvedRoundMinutes: 5, summarySeconds: 30, workerReportSeconds: 5, databaseLogSeconds: 60, standaloneSaveSeconds: 60 },
	logging: { verbose: false, generationDiagnostics: true, generationDiagnosticsMinimumSeconds: 5, eventLoopResolutionMilliseconds: 20 },
	validation: { checkpointInputs: 20, probabilisticInputs: 202, maximumWires: 64 },
	search: { probabilistic: true, variableElimination: true, exactMaximumWires: 7, subsetMinimum: 2, subsetMaximum: 199, sliceMinimum: 2, sliceMaximum: 199, maximumInnerChunks: 5, minimumInnerChunkGates: 200, workerShufflePasses: 200, roundShufflePasses: 2000, adaptive: true, stableSearchArms: false, schedulerHistoryEntries: 128, independentComponents: false, schedulerDecay: 0.98, localSearch: true, localSearchSeeds: 32, localSearchRadius: 16, localSearchBroadEvery: 5, explorationEvery: 5, searchArms: 16, prioritizeChangedWires: true, incrementalEvaluation: true, incrementalDependencies: true, circuitChunkGates: 128, prefixCacheBytes: 8388608, prefixStride: 16, normalizedCacheEntries: 10000, balancedWorkers: true },
	cache: { lookupPolicy: 'lru' as 'fifo' | 'lru', lookupEntries: 1000000, processedEntries: 1000000, shuffleEntries: 100000, subsetEntries: 100000, windowKeyBytes: 16777216 },
	database: { tables: [{ wires: 3, gates: 6 }, { wires: 4, gates: 5 }, { wires: 5, gates: 2 }], queryBatchSize: 900, lookupBatchMilliseconds: 0, statementCacheEntries: 16, sharedTables: true, sharedTableBytes: 33554432, sharedTableMaximumRows: 100000, memoryMapBytes: 268435456, generationStates: 0, generationBatchRows: 3000, generationReadRows: 4096, generationSqlParameters: 8192, generationPreparedInserts: true, generationCompactBindings: true, generationStagingWriters: 1, generationAppendStaging: false, generationAggregateMerge: true, generationCountFinalInserts: false, generationDirectInputMerge: true, generationSortStaging: false, generationStatementCacheEntries: 8, generationCacheMegabytes: 256, generationTempStore: 'file' as 'file' | 'memory', generationJournalMode: 'wal' as 'wal' | 'delete', generationSynchronous: 'full' as 'full' | 'normal', generationWorkers: 8, generationPrefetch: true, generationPrefetchMegabytes: 16, generationQueueBatches: 2, generationMinimumWork: 100000, etaWindowSamples: 5, etaWarmupSamples: 3, etaSmoothing: 0.2, etaMaximumSlowdown: 1, etaTrendWindowSamples: 60, etaTrendMinimumSamples: 10, etaTrendMinimumWorkGrowth: 0.25 },
	benchmark: { generationFinalComparison: false, finalLookupOutputName: 'final-lookup-benchmark.json', generationWriterComparison: false, generationPrefetchComparison: false, generationStagingComparison: false, mergeOutputName: 'merge-benchmark.json', stagingWideSqlParameters: 16384, stagingRows: 200000, stagingOutputName: 'staging-benchmark.json', dedupSeenRows: [10000, 100000, 1000000], dedupCandidateFunctions: 2000, dedupMasksPerFunction: 4, dedupOutputName: 'dedup-benchmark.json', generationTables: [{ wires: 3, gates: 3 }, { wires: 4, gates: 2 }], generationOutputName: 'generation-benchmark.json', generationTimeoutSeconds: 600, variants: [] as string[], decayFactor: 0.98, mode: 'comparison' as 'comparison' | 'ablation', caseManifest: 'benchmarks/cases.json', caseOutputDirectory: 'benchmark-cases', seconds: 10, repeats: 3, seed: 1729, workerCounts: [1, 2, 4], maximumChecks: 0, maximumOverrunSeconds: 30, outputName: 'benchmark.json' },
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
			if (section === 'benchmark' && key === 'variants') {
				const allowed = ['reference', 'shared-tables', 'components', 'stable-arms', 'decay', 'lru', 'tuned', 'tuned-no-stable', 'tuned-conservative']
				if (!Array.isArray(setting) || setting.some(name => typeof name !== 'string' || !allowed.includes(name)) || new Set(setting).size !== setting.length) throw new Error('Invalid benchmark variants')
				target[key] = setting.slice(); continue
			}
			if (section === 'benchmark' && (key === 'workerCounts' || key === 'dedupSeenRows')) {
				if (!Array.isArray(setting) || !setting.length || setting.some(n => !Number.isSafeInteger(n) || n < 1) || new Set(setting).size !== setting.length) throw new Error(`benchmark.${key} needs distinct positive integers`)
				target[key] = setting.slice(); continue
			}
			if ((section === 'database' && key === 'tables') || (section === 'benchmark' && key === 'generationTables')) {
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
			if (typeof setting === 'number' && (!Number.isFinite(setting) || (setting < 0 || (setting === 0 && !['memoryMapBytes', 'generationStates', 'lookupBatchMilliseconds', 'maximumChecks'].includes(key))) || (key !== 'maximumChunkFraction' && key !== 'etaSmoothing' && key !== 'etaMaximumSlowdown' && key !== 'etaTrendMinimumWorkGrowth' && key !== 'schedulerDecay' && key !== 'decayFactor' && key !== 'concurrencyDatabaseFraction' && key !== 'concurrencyRateTolerance' && key !== 'seconds' && !key.endsWith('Minutes') && !key.endsWith('Seconds') && !Number.isSafeInteger(setting)))) throw new Error(`Invalid positive setting: ${section}.${key}`)
			target[key] = setting
		}
	}
	const { search, timing, database, validation, workers, files } = result
	if ([result.benchmark.generationFinalComparison, result.benchmark.generationPrefetchComparison, result.benchmark.generationStagingComparison, result.benchmark.generationWriterComparison].filter(Boolean).length > 1) throw new Error('Choose one generation comparison mode')
	if (result.logging.eventLoopResolutionMilliseconds > 1000) throw new Error('Event-loop resolution must be at most 1000 milliseconds')
	if (database.generationSqlParameters < 5 || database.generationSqlParameters > 32766 || result.benchmark.stagingWideSqlParameters < 5 || result.benchmark.stagingWideSqlParameters > 32766) throw new Error('generationSqlParameters must be between 5 and 32766')
	if (!['file', 'memory'].includes(database.generationTempStore) || !['wal', 'delete'].includes(database.generationJournalMode) || !['full', 'normal'].includes(database.generationSynchronous)) throw new Error('Invalid generation SQLite settings')
	if (![1, 2, 4].includes(database.generationStagingWriters) || (database.generationStagingWriters > 1 && database.generationAppendStaging)) throw new Error('Choose 1, 2 or 4 staging writers; parallel writers require indexed staging')
	if (database.generationCacheMegabytes > 1048576) throw new Error('Generation cache budget exceeds supported limit')
	if (result.benchmark.dedupMasksPerFunction > 256 || Math.ceil(result.benchmark.dedupCandidateFunctions / 2) > Math.min(...result.benchmark.dedupSeenRows)) throw new Error('Invalid dedup benchmark dimensions')
	if (!['comparison', 'ablation'].includes(result.benchmark.mode)) throw new Error('Invalid benchmark mode')
	if (!['fifo', 'lru'].includes(result.cache.lookupPolicy)) throw new Error('Invalid lookup cache policy')
	if (workers.concurrencyDatabaseFraction > 1 || workers.concurrencyRateTolerance >= 1 || database.sharedTableBytes > 0x7fffffff) throw new Error('Invalid resource limits')
	if (result.benchmark.decayFactor > 1) throw new Error('benchmark.decayFactor must be at most 1')
	if (search.schedulerDecay > 1) throw new Error('search.schedulerDecay must be at most 1')
	if (database.etaMaximumSlowdown < 1) throw new Error('etaMaximumSlowdown must be at least 1')
	if (database.etaTrendMinimumSamples < 3 || database.etaTrendMinimumSamples > database.etaTrendWindowSamples) throw new Error('Invalid ETA trend history settings')
	if (database.etaSmoothing > 1 || database.etaWarmupSamples > database.etaWindowSamples) throw new Error('Invalid ETA smoothing settings')
	if (result.synthesis.maximumWires > 4) throw new Error('synthesis.maximumWires must be at most 4')
	if (search.subsetMinimum < 2 || search.sliceMinimum < 2 || search.subsetMaximum < search.subsetMinimum || search.sliceMaximum < search.sliceMinimum) throw new Error('Invalid search size ranges')
	if (search.exactMaximumWires > 16 || search.exactMaximumWires > validation.maximumWires || database.tables.some(table => table.wires > validation.maximumWires) || validation.maximumWires > 1024 || database.queryBatchSize > 900) throw new Error('Config exceeds supported wire or database batch limits')
	if (timing.improvedRoundMinutes > timing.roundMinutes || workers.maximumChunkFraction > 1) throw new Error('Invalid round timing or chunk fraction')
	for (const name of [files.latestName, files.workerDirectory, files.progressDirectory, result.benchmark.outputName, result.benchmark.caseOutputDirectory, result.benchmark.generationOutputName, result.benchmark.dedupOutputName, result.benchmark.stagingOutputName, result.benchmark.mergeOutputName, result.benchmark.finalLookupOutputName]) {
		if (name === '.' || name === '..' || /[\\/]/.test(name)) throw new Error('Output names must be single file or directory names')
	}
	return result
}

export const configPath = resolve(process.env.OPTIMIZER_CONFIG ?? fileURLToPath(new URL('../solver.config.json', import.meta.url)))
export const config: SolverConfig = !isMainThread && workerData?.solverConfig
	? parseConfig(workerData.solverConfig)
	: parseConfig(JSON.parse(readFileSync(configPath, 'utf8')))
