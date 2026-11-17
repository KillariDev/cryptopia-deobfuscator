import { GenerationActivity } from './generation-prefetch.js'
import sqlite3 from 'sqlite3'
import { availableParallelism } from 'os'
import { monitorEventLoopDelay, performance } from 'perf_hooks'
import { SQLObserver, SQLSnapshot } from './sql-observer.js'
import { GenerationProfile } from './generation-progress.js'

type Counters = { phase: string, at: number, cpu: NodeJS.CpuUsage, io: NodeJS.ResourceUsage, loop: ReturnType<typeof performance.eventLoopUtilization>, sql: SQLSnapshot, phases: number[] }
export type DiagnosticSample = { phase: string, seconds: number, cores: number, available: number, loopBusy: number, loopP95Ms: number, rssMiB: number, sqlCalls: number, nativeCalls: number, nativeMs: number, apiMs: number, activeSQL: number, oldestSQLMs: number, ioRead: number, ioWrite: number, phases: number[] }
const fields = ['readMs', 'stagingMs', 'dedupMs', 'outputMs', 'commitMs'] as const
const names = ['reading', 'staging', 'deduplicating', 'writing lookup', 'committing']
export function diagnosticDelta(previous: Counters, current: Counters, p95: number, rss: number, available: number): DiagnosticSample {
	const ms = Math.max(1, current.at - previous.at)
	const active = current.loop.active - previous.loop.active, idle = current.loop.idle - previous.loop.idle
	return { phase: current.phase, seconds: ms / 1000, cores: Math.max(0, current.cpu.user + current.cpu.system - previous.cpu.user - previous.cpu.system) / (ms * 1000), available,
		loopBusy: active + idle > 0 ? active / (active + idle) : 0, loopP95Ms: Number.isFinite(p95) ? p95 : 0, rssMiB: rss / 1048576,
		sqlCalls: current.sql.calls - previous.sql.calls, nativeCalls: current.sql.nativeCalls - previous.sql.nativeCalls, nativeMs: current.sql.nativeMs - previous.sql.nativeMs,
		apiMs: Math.max(0, current.sql.awaitMs - previous.sql.awaitMs), activeSQL: current.sql.active, oldestSQLMs: current.sql.oldestMs,
		ioRead: Math.max(0, current.io.fsRead - previous.io.fsRead), ioWrite: Math.max(0, current.io.fsWrite - previous.io.fsWrite), phases: current.phases.map((value, i) => Math.max(0, value - previous.phases[i])) }
}
export function formatDiagnosticSample(sample: DiagnosticSample, activity?: GenerationActivity) {
	const labels = ['read', 'stage', 'dedup', 'lookup', 'commit']
	const phases = sample.phases.map((value, i) => ({ name: labels[i], ms: value })).sort((a, b) => b.ms - a.ms).filter(row => row.ms > 0)
	const split = phases.map(row => `${row.name} ${(row.ms / 1000).toFixed(1)}s`).join(', ')
	const hint = sample.loopBusy > .75 ? 'main event loop busy' : sample.apiMs > sample.seconds * 600 ? (sample.cores < .6 ? 'SQL waits dominate; I/O or synchronization possible' : 'SQL path dominates; CPU and I/O may both contribute') : 'mixed work; no single limit established'
	return [
		`Generation resources (last ${sample.seconds.toFixed(0)}s): CPU ${sample.cores.toFixed(2)} core-equivalents / ${sample.available} available; main loop ${(sample.loopBusy * 100).toFixed(0)}% busy, delay p95 ${sample.loopP95Ms.toFixed(1)}ms; RSS ${sample.rssMiB.toFixed(0)}MiB.`,
		`Generation SQL: ${sample.sqlCalls} API calls; API elapsed ${(sample.apiMs / 1000).toFixed(1)}s (includes native); ${sample.nativeCalls} completed native profiles, ${(sample.nativeMs / 1000).toFixed(1)}s; in flight ${sample.activeSQL}${sample.activeSQL ? ` (${(sample.oldestSQLMs / 1000).toFixed(1)}s oldest)` : ''}; OS I/O counters R/W ${sample.ioRead}/${sample.ioWrite} (not bytes/latency).`,
		`Generation work (same interval; active ${sample.phase}): ${split || 'no measured phase yet'}; ${hint}.${activity ? ` Workers ${activity.running} active/${activity.queued} queued; lookahead ${activity.lookaheadBatches} batch, ${(activity.bufferedBytes / 1048576).toFixed(1)}MiB buffered (target ${(activity.bufferLimitBytes / 1048576).toFixed(0)}MiB across current/next buffers; chunk/worker buffers extra).` : ''}`
	]
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
	private counters(profile?: GenerationProfile, phase?: string): Counters {
		const at = performance.now()
		return { phase: phase ?? profile?.phase ?? 'initializing', at, cpu: process.cpuUsage(), io: process.resourceUsage(), loop: performance.eventLoopUtilization(), sql: this.observer.snapshot(at), phases: fields.map((field, i) => (profile?.[field] ?? 0) + (profile?.phase === names[i] ? Math.max(0, at - profile.phaseStarted) : 0)) }
	}
	sample(profile?: GenerationProfile, phase?: string) {
		if (this.closed) return undefined
		const next = this.counters(profile, phase)
		if (next.at - this.previous.at < this.minimumSeconds * 1000) return undefined
		const sample = diagnosticDelta(this.previous, next, this.histogram!.count ? this.histogram!.percentile(95) / 1e6 : 0, process.memoryUsage.rss(), availableParallelism())
		this.previous = next; this.histogram!.reset()
		return sample
	}
	close() { if (!this.closed) { this.closed = true; this.histogram?.disable(); this.observer.close() } }
}
