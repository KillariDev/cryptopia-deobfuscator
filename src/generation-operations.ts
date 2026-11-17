export type GenerationOperation = 'input lookup' | 'final membership/count' | 'arm final counter' | 'read final count' | 'disarm final counter' | 'final lookup' | 'insert seen' | 'update frontier' | 'consume frontier' | 'update checkpoint' | 'update layer'
export type OperationTiming = { name: GenerationOperation, ms: number, calls: number }
/** Bounded labels, no SQL text or circuit data. Include unfinished operations so
 * a minute-long query is visible before its callback completes. */
export class GenerationOperations {
	private totals = new Map<GenerationOperation, OperationTiming>()
	private pending = new Map<number, { name: GenerationOperation, at: number }>()
	private sequence = 0
	constructor(private now = () => performance.now()) {}
	async measure<T>(name: GenerationOperation, operation: () => Promise<T>): Promise<T> {
		const at = this.now(), id = this.sequence++; this.pending.set(id, { name, at })
		try { return await operation() } finally {
			this.pending.delete(id)
			const total = this.totals.get(name) ?? { name, ms: 0, calls: 0 }
			total.ms += this.now() - at; total.calls++; this.totals.set(name, total)
		}
	}
	snapshot(): OperationTiming[] {
		const now = this.now(), totals = new Map([...this.totals].map(([name, value]) => [name, { ...value }]))
		for (const { name, at } of this.pending.values()) {
			const total = totals.get(name) ?? { name, ms: 0, calls: 0 }
			total.ms += now - at; totals.set(name, total)
		}
		return [...totals.values()]
	}
}
