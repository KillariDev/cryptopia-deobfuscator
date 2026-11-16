import { Gate } from './types.js'

type Request = { promise: Promise<Gate[] | null>, resolve: (value: Gate[] | null) => void, reject: (error: unknown) => void }
export class LookupBatcher {
	private inFlight = new Map<string, Request>()
	private pending: string[] = []
	private scheduled = false
	constructor(private maximum: number, private delayMs: number, private fetch: (ids: string[]) => Promise<Map<string, Gate[]>>) {}
	get(id: string) {
		const existing = this.inFlight.get(id)
		if (existing) return existing.promise
		let resolve!: Request['resolve'], reject!: Request['reject']
		const promise = new Promise<Gate[] | null>((yes, no) => { resolve = yes; reject = no })
		this.inFlight.set(id, { promise, resolve, reject }); this.pending.push(id)
		if (!this.scheduled) {
			this.scheduled = true
			if (this.delayMs === 0) queueMicrotask(() => { void this.flush() })
			else setTimeout(() => { void this.flush() }, this.delayMs)
		}
		return promise
	}
	private async flush() {
		const ids = this.pending; this.pending = []; this.scheduled = false
		for (let i = 0; i < ids.length; i += this.maximum) {
			const batch = ids.slice(i, i + this.maximum)
			try {
				const matches = await this.fetch(batch)
				for (const id of batch) this.inFlight.get(id)!.resolve(matches.get(id) ?? null)
			} catch (error) { for (const id of batch) this.inFlight.get(id)!.reject(error) }
			finally { for (const id of batch) this.inFlight.delete(id) }
		}
	}
}
