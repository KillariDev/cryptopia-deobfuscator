import { OperationTiming } from './generation-operations.js'
import { GenerationActivity } from './generation-prefetch.js'
import sqlite3 from 'sqlite3'
import { availableParallelism } from 'os'
import { monitorEventLoopDelay, performance } from 'perf_hooks'
import { SQLObserver, SQLSnapshot } from './sql-observer.js'
import { GenerationProfile } from './generation-progress.js'

type Counters = { phase: string, at: number, cpu: NodeJS.CpuUsage, io: NodeJS.ResourceUsage, loop: ReturnType<typeof performance.eventLoopUtilization>, sql: SQLSnapshot, phases: number[], writerMs?: number, allBusyMs?: number, committedParents?: number, stagingRows?: number[], operations?: OperationTiming[], candidateCacheChecked?: number, candidateCacheSkipped?: number }
export type DiagnosticSample = { phase: string, seconds: number, cores: number, available: number, loopBusy: number, loopP95Ms: number, rssMiB: number, sqlCalls: number, nativeCalls: number, nativeMs: number, apiMs: number, activeSQL: number, oldestSQLMs: number, ioRead: number, ioWrite: number, phases: number[], averageWriters: number, allBusyFraction: number, parentsPerSecond: number, stagingShares?: number[], operations: OperationTiming[], candidateSkipFraction?: number }
const fields = ['readMs', 'stagingMs', 'dedupMs', 'outputMs', 'commitMs', 'importMs'] as const
const names = ['reading', 'staging', 'deduplicating', 'writing lookup', 'committing', 'importing scratch']
export function diagnosticDelta(previous: Counters, current: Counters, p95: number, rss: number, available: number): DiagnosticSample {
	const ms = Math.max(1, current.at - previous.at)
	const routed = current.stagingRows?.map((value, i) => Math.max(0, value - (previous.stagingRows?.[i] ?? 0)))
	const totalRouted = routed?.reduce((sum, value) => sum + value, 0) ?? 0
	const active = current.loop.active - previous.loop.active, idle = current.loop.idle - previous.loop.idle
	const checked = Math.max(0, (current.candidateCacheChecked ?? 0) - (previous.candidateCacheChecked ?? 0))
	const skipped = Math.max(0, (current.candidateCacheSkipped ?? 0) - (previous.candidateCacheSkipped ?? 0))
	const previousOperations = new Map(previous.operations?.map(row => [row.name, row]))
	const operations = (current.operations ?? []).map(row => ({ name: row.name, ms: Math.max(0, row.ms - (previousOperations.get(row.name)?.ms ?? 0)), calls: Math.max(0, row.calls - (previousOperations.get(row.name)?.calls ?? 0)) }))
	return { candidateSkipFraction: checked ? Math.min(1, skipped / checked) : undefined, operations, phase: current.phase, seconds: ms / 1000, cores: Math.max(0, current.cpu.user + current.cpu.system - previous.cpu.user - previous.cpu.system) / (ms * 1000), available,
		loopBusy: active + idle > 0 ? active / (active + idle) : 0, loopP95Ms: Number.isFinite(p95) ? p95 : 0, rssMiB: rss / 1048576,
		stagingShares: totalRouted ? routed!.map(value => value / totalRouted) : undefined,
		averageWriters: Math.max(0, (current.writerMs ?? 0) - (previous.writerMs ?? 0)) / ms,
		allBusyFraction: Math.min(1, Math.max(0, (current.allBusyMs ?? 0) - (previous.allBusyMs ?? 0)) / ms),
		parentsPerSecond: Math.max(0, (current.committedParents ?? 0) - (previous.committedParents ?? 0)) * 1000 / ms,
		sqlCalls: current.sql.calls - previous.sql.calls, nativeCalls: current.sql.nativeCalls - previous.sql.nativeCalls, nativeMs: current.sql.nativeMs - previous.sql.nativeMs,
		apiMs: Math.max(0, current.sql.awaitMs - previous.sql.awaitMs), activeSQL: current.sql.active, oldestSQLMs: current.sql.oldestMs,
		ioRead: Math.max(0, current.io.fsRead - previous.io.fsRead), ioWrite: Math.max(0, current.io.fsWrite - previous.io.fsWrite), phases: current.phases.map((value, i) => Math.max(0, value - previous.phases[i])) }
}
export function formatDiagnosticSample(sample: DiagnosticSample, activity?: GenerationActivity) {
	const labels = ['read', 'stage wait', 'dedup', 'lookup', 'commit', 'scratch import']
	const phases = sample.phases.map((value, i) => ({ name: labels[i], ms: value })).sort((a, b) => b.ms - a.ms).filter(row => row.ms > 0)
	const split = phases.map(row => `${row.name} ${(row.ms / 1000).toFixed(1)}s`).join(', ')
	const hint = sample.loopBusy > .75 ? 'main event loop busy' : sample.apiMs > sample.seconds * 600 ? (sample.cores < .6 ? 'SQL waits dominate; I/O or synchronization possible' : 'SQL path dominates; CPU and I/O may both contribute') : 'mixed work; no single limit established'
	const lines = [
		`Generation resources (last ${sample.seconds.toFixed(0)}s): CPU ${sample.cores.toFixed(2)} core-equivalents / ${sample.available} available; main loop ${(sample.loopBusy * 100).toFixed(0)}% busy, delay p95 ${sample.loopP95Ms.toFixed(1)}ms; RSS ${sample.rssMiB.toFixed(0)}MiB.`,
		`Generation SQL: ${sample.sqlCalls} API calls; API elapsed ${(sample.apiMs / 1000).toFixed(1)}s (includes native; concurrent calls overlap); ${sample.nativeCalls} completed native profiles (all writers), ${(sample.nativeMs / 1000).toFixed(1)}s; in flight ${sample.activeSQL}${sample.activeSQL ? ` (${(sample.oldestSQLMs / 1000).toFixed(1)}s oldest)` : ''}; OS I/O counters R/W ${sample.ioRead}/${sample.ioWrite} (not bytes/latency).`,
		`Generation work (same interval; snapshot ${sample.phase}): ${split || 'no measured phase yet'}; ${sample.parentsPerSecond.toFixed(1)} committed parents/s; ${hint}.${activity ? ` Staging writer utilization ${(Math.min(1, sample.averageWriters / (activity.stagingWriters ?? 1)) * 100).toFixed(0)}% of ${activity.stagingWriters ?? 1} slot(s)${(activity.stagingWriters ?? 1) > 1 ? `, all busy ${(sample.allBusyFraction * 100).toFixed(0)}% of interval` : ''}${sample.stagingShares && sample.stagingShares.length > 1 ? `, candidate split ${sample.stagingShares.map(value => `${(value * 100).toFixed(0)}%`).join('/')}` : ''}${activity.streamingStaging ? `; snapshot staging queue ${activity.stagingQueueBatches ?? 0}/${activity.stagingQueueCapacity ?? 0} batches` : ''}${activity.candidateCacheBytes ? `; exact candidate cache ${(activity.candidateCacheBytes / 1048576).toFixed(0)}MiB${sample.candidateSkipFraction === undefined ? '' : `, skipped ${(sample.candidateSkipFraction * 100).toFixed(0)}% of rows before SQL`}` : ''}; snapshot expansion workers ${activity.running} active/${activity.queued} queued; lookahead ${activity.lookaheadBatches} batch, ${(activity.bufferedBytes / 1048576).toFixed(1)}MiB buffered (target ${(activity.bufferLimitBytes / 1048576).toFixed(0)}MiB across current/next buffers; chunk/worker buffers extra).` : ''}`
	]
	const hottest = sample.operations.filter(row => row.ms >= 50).sort((a, b) => b.ms - a.ms).slice(0, 3)
	if (hottest.length) lines.push(`Generation SQL operations (same interval): ${hottest.map(row => `${row.name} ${(row.ms / 1000).toFixed(1)}s`).join('; ')}. API elapsed includes binding, SQLite and waits.`)
	return lines
}
export class GenerationDiagnostics {
	private observer: SQLObserver
	private histogram?: ReturnType<typeof monitorEventLoopDelay>
	private previous: Counters
	private closed = false
	constructor(db: sqlite3.Database, resolution: number, private minimumSeconds: number) {
		this.observer = new SQLObserver(db)
		try {
			this.histogram = monitorEventLoopDelay({ resolution }); this.histogram.enable()
			this.previous = this.counters()
		} catch (error) { this.histogram?.disable(); this.observer.close(); throw error }
	}
	private counters(profile?: GenerationProfile, phase?: string, activity?: GenerationActivity): Counters {
		const at = performance.now()
		return { phase: phase ?? (profile ? profile.phaseActive || profile.phase === 'complete' ? profile.phase : 'between operations' : 'initializing'), at, cpu: process.cpuUsage(), io: process.resourceUsage(), loop: performance.eventLoopUtilization(), sql: this.observer.snapshot(at), candidateCacheChecked: activity?.candidateCacheChecked, candidateCacheSkipped: activity?.candidateCacheSkipped, operations: activity?.operations, stagingRows: activity?.stagingRows, writerMs: activity?.writerMs, allBusyMs: activity?.allBusyMs, committedParents: profile?.committedParents, phases: fields.map((field, i) => (profile?.[field] ?? 0) + (profile?.phaseActive && profile.phase === names[i] ? Math.max(0, at - profile.phaseStarted) : 0)) }
	}
	sample(profile?: GenerationProfile, phase?: string, activity?: GenerationActivity) {
		if (this.closed) return undefined
		const next = this.counters(profile, phase, activity)
		if (next.at - this.previous.at < this.minimumSeconds * 1000) return undefined
		const sample = diagnosticDelta(this.previous, next, this.histogram!.count ? this.histogram!.percentile(95) / 1e6 : 0, process.memoryUsage.rss(), availableParallelism())
		this.previous = next; this.histogram!.reset()
		return sample
	}
	close() { if (!this.closed) { this.closed = true; this.histogram?.disable(); this.observer.close() } }
}
