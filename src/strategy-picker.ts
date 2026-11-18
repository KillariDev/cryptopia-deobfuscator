/** Predictable rotation for each eligible solver group, independent of region sizes. */
export class StrategyPicker {
	private next = new Map<string, number>()
	constructor(private order: string[]) {}
	pick<T extends { name: string }>(available: T[]): T | undefined {
		const choices = this.order.flatMap(name => available.filter(choice => choice.name === name))
		if (!choices.length) return undefined
		const key = choices.map(choice => choice.name).join(',')
		const index = (this.next.get(key) ?? 0) % choices.length
		this.next.set(key, (index + 1) % choices.length)
		return choices[index]
	}
}
