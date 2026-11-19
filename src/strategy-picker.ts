/** Predictable rotation for each eligible solver group in unpinned searches. */
export class StrategyPicker {
	private next = new Map<string, number>()
	constructor(private order: readonly string[]) {}
	pick<T extends { name: string }>(available: T[]): T | undefined {
		const choices = this.order.flatMap(name => available.filter(choice => choice.name === name))
		if (!choices.length) return undefined
		const key = choices.map(choice => choice.name).join(',')
		const index = (this.next.get(key) ?? 0) % choices.length
		this.next.set(key, index + 1)
		return choices[index]
	}
}

/** A persistent worker keeps its strategy through all jobs in a round. */
export class RoundStrategyPicker {
	private index: number
	private round?: number
	private reduced = false
	constructor(private order: readonly string[], offset = 0) {
		this.index = order.length ? offset % order.length : 0
	}
	get activeStrategy() { return this.order[this.index] }
	beginRound(round: number, assignedStrategy?: string) {
		if (round === this.round) return
		if (assignedStrategy !== undefined) {
			const index = this.order.indexOf(assignedStrategy)
			if (index < 0) throw new Error(`Unknown assigned strategy: ${assignedStrategy}`)
			this.index = index
		} else if (this.round !== undefined && !this.reduced && this.order.length) {
			this.index = (this.index + 1) % this.order.length
		}
		this.round = round
		this.reduced = false
	}
	pick<T extends { name: string }>(available: T[]): T | undefined {
		return available.find(choice => choice.name === this.activeStrategy)
	}
	observe(name: string, gatesRemoved: number) {
		if (name === this.activeStrategy && gatesRemoved > 0) this.reduced = true
	}
}
