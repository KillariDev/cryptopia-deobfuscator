import { defaultConfigPath, readConfigDocument } from './config-document.js'
import { fileURLToPath } from 'url'
import { resolve } from 'path'
import { isMainThread, workerData } from 'worker_threads'

export type RainbowTableSpec = { wires: number, gates: number }

export const defaultLocalStrategyOrder = [
	'quadratic', 'rainbow', 'variables', 'forward-semantic-search', 'equality-saturation',
	'gf2-affine', 'factored', 'block-cancellation', 'sat-sweeping', 'mixed-basis', 'z3', 'meet-in-the-middle',
] as const
export const defaultBroadStrategyOrder = [
	'sat-sweeping', 'quadratic-shear', 'mixed-basis', 'block-cancellation', 'symbolic', 'factored', 'dependency-cuts',
] as const

export const defaults = {
	runtime: { heapMegabytes: 16384 },
	files: { dataDirectory: 'data', latestName: 'latest.json', workerDirectory: 'worker', workerSnapshots: false, progressDirectory: 'progress', databaseDirectory: '.' },
	workers: { broadSearchIdleSeconds: 30, keepBusy: true, broadSearchSeconds: 60, wholeCircuitMaximumGates: 2000, maximum: 24, minimumChunkGates: 100, maximumChunkFraction: 0.5, jobsPerWorker: 4, jobSeconds: 120, adaptiveConcurrency: true, initialConcurrency: 4, concurrencySampleRounds: 2, concurrencyDatabaseFraction: 0.6, concurrencyRateTolerance: 0.05, memoryBudgetMegabytes: 8192 },
	timing: { checkpointSeconds: 30, roundSeconds: 1500, improvedRoundSeconds: 300, summarySeconds: 30, workerReportSeconds: 5, databaseLogSeconds: 60, standaloneSaveSeconds: 60 },
	logging: { verbose: false, generationDiagnostics: true, generationDiagnosticsMinimumSeconds: 5, eventLoopResolutionSeconds: 0.02 },
	validation: { checkpointInputs: 20, probabilisticInputs: 202, maximumWires: 64 },
	search: { rainbow: true, dependencyCuts: true, strategyAdaptive: true, localStrategyOrder: [] as string[], broadStrategyOrder: [] as string[], probabilistic: true, variableElimination: true, exactMaximumWires: 7, subsetMinimum: 2, subsetMaximum: 199, sliceMinimum: 2, sliceMaximum: 199, maximumInnerChunks: 5, minimumInnerChunkGates: 200, workerShufflePasses: 200, roundShufflePasses: 2000, adaptive: false, stableSearchArms: false, schedulerHistoryEntries: 128, independentComponents: false, schedulerDecay: 0.98, localSearch: true, localSearchSeeds: 32, localSearchRadius: 16, localSearchBroadEvery: 5, explorationEvery: 5, searchArms: 16, prioritizeChangedWires: true, incrementalEvaluation: true, incrementalDependencies: true, circuitChunkGates: 128, prefixCacheBytes: 8388608, prefixStride: 16, normalizedCacheEntries: 10000, balancedWorkers: true },
	cache: { lookupPolicy: 'lru' as 'fifo' | 'lru', lookupEntries: 1000000, processedEntries: 1000000, shuffleEntries: 100000, subsetEntries: 100000, windowKeyBytes: 16777216 },
	database: { tables: [{ wires: 3, gates: 6 }, { wires: 4, gates: 5 }, { wires: 5, gates: 2 }], queryBatchSize: 900, lookupBatchSeconds: 0, statementCacheEntries: 16, sharedTables: true, sharedTableBytes: 33554432, sharedTableMaximumRows: 100000, memoryMapBytes: 268435456, generationStates: 0, generationBatchRows: 3000, generationReadRows: 4096, generationSqlParameters: 8192, generationPreparedInserts: true, generationCompactBindings: true, generationStagingWriters: 1, generationAppendStaging: false, generationAggregateMerge: true, generationCountFinalInserts: false, generationCandidateCacheMegabytes: 32, generationStreamStaging: true, generationStagingQueueBatches: 2, generationDirectInputMerge: true, generationSortStaging: false, generationStatementCacheEntries: 8, generationCacheMegabytes: 256, generationTempStore: 'file' as 'file' | 'memory', generationJournalMode: 'wal' as 'wal' | 'delete', generationSynchronous: 'full' as 'full' | 'normal', generationWorkers: 8, generationPrefetch: true, generationPrefetchMegabytes: 16, generationQueueBatches: 2, generationMinimumWork: 100000, etaWindowSamples: 5, etaWarmupSamples: 3, etaSmoothing: 0.2, etaMaximumSlowdown: 1, etaTrendWindowSamples: 60, etaTrendMinimumSamples: 10, etaTrendMinimumWorkGrowth: 0.25 },
	benchmark: { generationStreamingComparison: false, generationFinalComparison: false, finalLookupOutputName: 'final-lookup-benchmark.json', generationWriterComparison: false, generationPrefetchComparison: false, generationStagingComparison: false, mergeOutputName: 'merge-benchmark.json', stagingWideSqlParameters: 16384, stagingRows: 200000, stagingOutputName: 'staging-benchmark.json', dedupSeenRows: [10000, 100000, 1000000], dedupCandidateFunctions: 2000, dedupMasksPerFunction: 4, dedupOutputName: 'dedup-benchmark.json', generationTables: [{ wires: 3, gates: 3 }, { wires: 4, gates: 2 }], generationOutputName: 'generation-benchmark.json', generationTimeoutSeconds: 600, variants: [] as string[], decayFactor: 0.98, mode: 'comparison' as 'comparison' | 'ablation', caseManifest: 'benchmarks/cases.json', caseOutputDirectory: 'benchmark-cases', seconds: 10, repeats: 3, seed: 1729, workerCounts: [1, 2, 4], maximumChecks: 0, maximumOverrunSeconds: 30, outputName: 'benchmark.json' },
	synthesis: { factored: true, blockCancellation: true, satSweeping: true, broadSatCutsFirst: false, mixedBasis: true, factoredMaximumNodes: 200000, factoredMaximumEdges: 16000000, quadratic: true, quadraticShear: true, affine: true, affineMaximumWindowGates: 256, affineMaximumTerms: 100000, affineMaximumOperations: 10000000, maximumWires: 3, maximumWindowGates: 8, maximumReplacementGates: 3, states: 2000, forwardSemanticSearch: true, smt: true, meetInMiddle: true, equalitySaturation: true },
}
export type SolverConfig = typeof defaults

// Keep one runtime representation for workers, benchmarks, and legacy JSON.
const strategySettings = {
	rainbow: { enabled: 'search.rainbow' },
	variables: { enabled: 'search.variableElimination', exactMaximumWires: 'search.exactMaximumWires', sampleCandidates: 'search.probabilistic', samples: 'validation.probabilisticInputs' },
	dependencyCuts: { enabled: 'search.dependencyCuts' },
	satSweeping: { enabled: 'synthesis.satSweeping', cutsFirst: 'synthesis.broadSatCutsFirst' },
	mixedBasis: { enabled: 'synthesis.mixedBasis' },
	blockCancellation: { enabled: 'synthesis.blockCancellation' },
	factored: { enabled: 'synthesis.factored' },
	gf2Affine: { enabled: 'synthesis.affine' },
	quadratic: { enabled: 'synthesis.quadratic' },
	quadraticShear: { enabled: 'synthesis.quadraticShear' },
	forwardSemantic: { enabled: 'synthesis.forwardSemanticSearch' },
	smt: { enabled: 'synthesis.smt' },
	meetInMiddle: { enabled: 'synthesis.meetInMiddle' },
	equalitySaturation: { enabled: 'synthesis.equalitySaturation' },
	factoredLimits: { maximumNodes: 'synthesis.factoredMaximumNodes', maximumEdges: 'synthesis.factoredMaximumEdges' },
	polynomialLimits: { maximumWindowGates: 'synthesis.affineMaximumWindowGates', maximumTerms: 'synthesis.affineMaximumTerms', maximumOperations: 'synthesis.affineMaximumOperations' },
	smallSynthesisLimits: { maximumWires: 'synthesis.maximumWires', maximumWindowGates: 'synthesis.maximumWindowGates', maximumReplacementGates: 'synthesis.maximumReplacementGates', states: 'synthesis.states' },
}

function expandStrategySettings(value: object) {
	const { strategies, ...sections } = value as Record<string, unknown>
	if (!Object.prototype.hasOwnProperty.call(value, 'strategies')) return sections
	if (!strategies || typeof strategies !== 'object' || Array.isArray(strategies)) throw new Error('Invalid config section: strategies')
	for (const [strategy, settings] of Object.entries(strategies)) {
		if (strategy === 'templates') continue // Settings from before template removal.
		if (!Object.prototype.hasOwnProperty.call(strategySettings, strategy)) throw new Error(`Unknown strategy group: ${strategy}`)
		if (!settings || typeof settings !== 'object' || Array.isArray(settings)) throw new Error(`Invalid strategy group: ${strategy}`)
		const fields = strategySettings[strategy as keyof typeof strategySettings] as Record<string, string>
		for (const [name, setting] of Object.entries(settings)) {
			if (!Object.prototype.hasOwnProperty.call(fields, name)) throw new Error(`Unknown config setting: strategies.${strategy}.${name}`)
			const [section, key] = fields[name].split('.')
			const previous = sections[section]
			if (previous !== undefined && (!previous || typeof previous !== 'object' || Array.isArray(previous))) throw new Error(`Invalid config section: ${section}`)
			sections[section] = { ...previous as object, [key]: setting }
		}
	}
	return sections
}

const legacyTimeSettings: Record<string, { key: string, scale: number }> = {
	'timing.roundMinutes': { key: 'roundSeconds', scale: 60 },
	'timing.improvedRoundMinutes': { key: 'improvedRoundSeconds', scale: 60 },
	'logging.eventLoopResolutionMilliseconds': { key: 'eventLoopResolutionSeconds', scale: 0.001 },
	'database.lookupBatchMilliseconds': { key: 'lookupBatchSeconds', scale: 0.001 },
}

export function parseConfig(value: unknown): SolverConfig {
	if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Solver config must be a JSON object')
	const result = structuredClone(defaults)
	for (const [section, values] of Object.entries(expandStrategySettings(value))) {
		if (!Object.prototype.hasOwnProperty.call(defaults, section)) throw new Error(`Unknown config section: ${section}`)
		if (!values || typeof values !== 'object' || Array.isArray(values)) throw new Error(`Invalid config section: ${section}`)
		for (const [sourceKey, sourceSetting] of Object.entries(values)) {
			const legacy = legacyTimeSettings[`${section}.${sourceKey}`]
			const key = legacy?.key ?? sourceKey
			if (legacy && Object.prototype.hasOwnProperty.call(values, key)) continue
			const setting = legacy && typeof sourceSetting === 'number' ? sourceSetting * legacy.scale : sourceSetting
			if (section === 'synthesis' && key === 'affineWholeCircuitSeconds') {
				if (typeof setting !== 'number' || !Number.isFinite(setting) || setting < 0) throw new Error('Invalid broad search cadence')
				if ((value as { workers?: Record<string, unknown> }).workers?.broadSearchSeconds === undefined) result.workers.broadSearchSeconds = setting
				continue
			}
			// Legacy strategy timers/cadence are accepted but no longer affect execution.
			if (section === 'synthesis' && ['timeoutMs', 'affineWholeCircuitMinutes', 'attemptEvery', 'templates', 'templateEntries'].includes(key)) continue
			if (section === 'search' && ['strategySpecialization', 'strategyExplorationProbability', 'strategyDecayHalfLifeSeconds'].includes(key)) continue
			if (section === 'workers' && ['shareTemplates', 'sharedTemplateSeconds', 'sharedTemplateEntries', 'sharedTemplateBatch'].includes(key)) continue
			const target = result[section as keyof SolverConfig] as Record<string, unknown>
			if (!Object.prototype.hasOwnProperty.call(target, key)) throw new Error(`Unknown config setting: ${section}.${key}`)
			if (section === 'search' && (key === 'localStrategyOrder' || key === 'broadStrategyOrder')) {
				const allowed: readonly string[] = key === 'localStrategyOrder' ? defaultLocalStrategyOrder : defaultBroadStrategyOrder
				if (!Array.isArray(setting) || setting.some(name => !allowed.includes(name)) || new Set(setting).size !== setting.length) {
					throw new Error(`search.${key} needs distinct strategy names from: ${allowed.join(', ')}`)
				}
				target[key] = setting.slice()
				continue
			}
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
			if (typeof setting === 'number' && (!Number.isFinite(setting) || (setting < 0 || (setting === 0 && !['broadSearchIdleSeconds', 'broadSearchSeconds', 'wholeCircuitMaximumGates', 'memoryMapBytes', 'generationStates', 'generationCandidateCacheMegabytes', 'lookupBatchSeconds', 'maximumChecks'].includes(key))) || (key !== 'maximumChunkFraction' && key !== 'etaSmoothing' && key !== 'etaMaximumSlowdown' && key !== 'etaTrendMinimumWorkGrowth' && key !== 'schedulerDecay' && key !== 'decayFactor' && key !== 'concurrencyDatabaseFraction' && key !== 'concurrencyRateTolerance' && key !== 'seconds' && !key.endsWith('Seconds') && !Number.isSafeInteger(setting)))) throw new Error(`Invalid positive setting: ${section}.${key}`)
			target[key] = setting
		}
	}
	const { search, timing, database, validation, workers, files } = result
	if ([result.benchmark.generationStreamingComparison, result.benchmark.generationFinalComparison, result.benchmark.generationPrefetchComparison, result.benchmark.generationStagingComparison, result.benchmark.generationWriterComparison].filter(Boolean).length > 1) throw new Error('Choose one generation comparison mode')
	if (result.logging.eventLoopResolutionSeconds > 1) throw new Error('Event-loop resolution must be at most 1 second')
	if (database.generationSqlParameters < 5 || database.generationSqlParameters > 32766 || result.benchmark.stagingWideSqlParameters < 5 || result.benchmark.stagingWideSqlParameters > 32766) throw new Error('generationSqlParameters must be between 5 and 32766')
	if (!['file', 'memory'].includes(database.generationTempStore) || !['wal', 'delete'].includes(database.generationJournalMode) || !['full', 'normal'].includes(database.generationSynchronous)) throw new Error('Invalid generation SQLite settings')
	if (![1, 2, 4].includes(database.generationStagingWriters) || (database.generationStagingWriters > 1 && database.generationAppendStaging)) throw new Error('Choose 1, 2 or 4 staging writers; parallel writers require indexed staging')
	if (database.generationCandidateCacheMegabytes > 1024) throw new Error('Candidate cache budget exceeds 1024 MiB')
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
	if (timing.improvedRoundSeconds > timing.roundSeconds || workers.maximumChunkFraction > 1) throw new Error('Invalid round timing or chunk fraction')
	for (const name of [files.latestName, files.workerDirectory, files.progressDirectory, result.benchmark.outputName, result.benchmark.caseOutputDirectory, result.benchmark.generationOutputName, result.benchmark.dedupOutputName, result.benchmark.stagingOutputName, result.benchmark.mergeOutputName, result.benchmark.finalLookupOutputName]) {
		if (name === '.' || name === '..' || /[\\/]/.test(name)) throw new Error('Output names must be single file or directory names')
	}
	return result
}

export const configPath = resolve(process.env.OPTIMIZER_CONFIG ?? defaultConfigPath(fileURLToPath(new URL('../', import.meta.url))))
export const config: SolverConfig = !isMainThread && workerData?.solverConfig
	? parseConfig(workerData.solverConfig)
	: parseConfig(readConfigDocument(configPath))

export const minimumBroadGates = () => Math.max(2, 1 + config.search.subsetMaximum, 1 + config.search.sliceMaximum)
