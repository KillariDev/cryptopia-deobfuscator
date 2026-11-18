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

export type AdaptivePickerOptions = { enabled: boolean, exploration: number, halfLifeSeconds: number }
/** Equal initial sampling, decaying productivity weights, and uniform exploration. */
export class AdaptiveStrategyPicker {
	private scores = new Map<string, { value: number, updated: number, attempts: number }>()
	private fallback: StrategyPicker
	constructor(private order: string[], private options: () => AdaptivePickerOptions, private random = Math.random, private clock = () => performance.now()) { this.fallback = new StrategyPicker(order) }
	private score(name: string, now: number) {
		const score = this.scores.get(name)
		return score ? score.value * 2 ** (-(now - score.updated) / (this.options().halfLifeSeconds * 1000)) : 0
	}
	probabilities(names: string[], now = this.clock()) {
		if (!names.length) return []
		const untried = names.filter(name => !this.scores.get(name)?.attempts)
		const epsilon = this.options().exploration
		if (untried.length) return names.map(name => epsilon / names.length + (untried.includes(name) ? (1 - epsilon) / untried.length : 0))
		const weights = names.map(name => 1 + Math.log1p(this.score(name, now)))
		const sum = weights.reduce((a, b) => a + b, 0)
		return weights.map(weight => epsilon / names.length + (1 - epsilon) * weight / sum)
	}
	pick<T extends { name: string }>(available: T[]): T | undefined {
		if (!this.options().enabled) return this.fallback.pick(available)
		const choices = this.order.flatMap(name => available.filter(choice => choice.name === name))
		const probabilities = this.probabilities(choices.map(choice => choice.name))
		let draw = this.random()
		for (let i = 0; i < choices.length; i++) { draw -= probabilities[i]; if (draw < 0) return choices[i] }
		return choices.at(-1)
	}
	observe(name: string, removed: number, elapsedMs: number) {
		const now = this.clock(), old = this.scores.get(name)
		const rate = Math.max(0, removed) * 1000 / Math.max(1, elapsedMs)
		this.scores.set(name, { value: old ? this.score(name, now) * 0.7 + rate * 0.3 : rate, updated: now, attempts: (old?.attempts ?? 0) + 1 })
	}
}
