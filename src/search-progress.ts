import { hashGates } from './utils.js'
import { LimitedMap } from './limitedMap.js'
import type { Gate } from './types.js'

type Region = { start: number, end: number }
export type SearchTask = Region & { slice: number }
type Scan = {
	input: Gate[]
	iterator?: Generator<Region>
	pending?: SearchTask
	retries: SearchTask[]
	deferred: SearchTask[]
	preferRetry: boolean
	retryFirst: boolean
}

/** Retain the cursor even after exhaustion. Alternate revisiting interrupted
 * work with fresh regions so either kind can use the next worker budget. */
export class SearchProgress {
	private readonly scans = new LimitedMap<string, Scan>(2, 'lru')
	private scan?: Scan

	get exhausted() {
		const scan = this.scan
		return !scan || (!scan.iterator && !scan.pending && !scan.retries.length && !scan.deferred.length)
	}

	reset(input: Gate[], regions: () => Generator<Region>, key = hashGates(input)) {
		const existing = this.scans.get(key)
		if (existing) {
			existing.retries.push(...existing.deferred)
			existing.deferred = []
			existing.preferRetry = !existing.preferRetry
			existing.retryFirst = existing.preferRetry
			this.scan = existing
			return
		}
		const previous = this.scan?.input
		let first = 0
		while (previous && first < input.length && first < previous.length) {
			const a = input[first], b = previous[first]
			if (a.a !== b.a || a.b !== b.b || a.target !== b.target || a.gate_i !== b.gate_i) break
			first++
		}
		const changed = previous?.length && first < input.length
		const priorities = changed ? [32, 128, 512, 2048].map(width => ({
			start: Math.max(0, first - width), end: Math.min(input.length, first + width),
		})) : []
		const iterator = (function* () {
			const priorityKeys = new Set<string>()
			for (const region of priorities) {
				const id = `${region.start}:${region.end}`
				if (!priorityKeys.has(id)) { priorityKeys.add(id); yield region }
			}
			for (const region of regions()) if (!priorityKeys.has(`${region.start}:${region.end}`)) yield region
		})()
		this.scan = { input: input.slice(), iterator, retries: [], deferred: [], preferRetry: true, retryFirst: false }
		this.scans.set(key, this.scan)
	}

	retry(task: SearchTask) { this.scan?.deferred.push(task) }

	next(minimum: number, subdivide = true): SearchTask | undefined {
		const scan = this.scan
		if (!scan) return undefined
		if (scan.retryFirst) {
			scan.retryFirst = false
			if (scan.retries.length) return scan.retries.shift()
		}
		if (!scan.pending) {
			const region = scan.iterator?.next()
			if (!region || region.done) {
				scan.iterator = undefined
				return scan.retries.shift()
			}
			scan.pending = { ...region.value, slice: region.value.end - region.value.start }
		}
		const result = { ...scan.pending }
		scan.pending.slice = Math.floor(scan.pending.slice / 2)
		if (!subdivide || scan.pending.slice < minimum) scan.pending = undefined
		return result
	}
}
