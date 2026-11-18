import { workerLearning } from './shared-learning.js'
const initialWeights: Record<string, number> = { variables: 5, templates: 5, 'forward-semantic-search': 5, 'equality-saturation': 5 }
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

export type AdaptivePickerOptions = { enabled: boolean, exploration: number, halfLifeSeconds: number, specialize?: boolean, startingWeights?: Record<string, number> }
export type StrategyWeight = { strategy: string, weight: number, attempts: number }
/** Equal initial sampling, decaying productivity weights, and uniform exploration. */
export class AdaptiveStrategyPicker {
	private scores = new Map<string, { value: number, updated: number, attempts: number, successes: number }>()
	private fallback: StrategyPicker
	private focus?: { name: string, misses: number, remaining: number, expires: number }
	private sharedRates = new Map<string, {at: number, value: number | undefined}>()
	constructor(private order: string[], private options: () => AdaptivePickerOptions, private random = Math.random, private clock = () => performance.now()) { this.fallback = new StrategyPicker(order) }
	private score(name: string, now: number) {
		const score = this.scores.get(name)
		let sample = this.sharedRates.get(name)
		if (!sample || now - sample.at >= 250) {
			sample = {at: now, value: workerLearning?.rate(name, this.options().halfLifeSeconds)}
			this.sharedRates.set(name, sample)
		}
		const shared = sample.value
		if (shared !== undefined) return shared
		return score ? score.value * 2 ** (-(now - score.updated) / (this.options().halfLifeSeconds * 1000)) : 0
	}
	private prior(name: string) {
		return (this.options().startingWeights ?? initialWeights)[name] ?? 1
	}
	private weight(name: string, now: number) {
		const attempts = this.scores.get(name)?.attempts ?? 0
		// Evidence grows gradually; a single fast sample cannot dominate.
		const confidence = attempts / (attempts + 8)
		return 1 + (this.prior(name) - 1) * (1 - confidence) + Math.min(3, Math.log1p(this.score(name, now))) * confidence
	}
	weights(now = this.clock()): StrategyWeight[] {
		return this.order.map(strategy => ({ strategy, weight: this.weight(strategy, now), attempts: this.scores.get(strategy)?.attempts ?? 0 }))
	}
	probabilities(names: string[], now = this.clock()) {
		if (!names.length) return []
		const minimum = Math.min(...names.map(name => this.scores.get(name)?.attempts ?? 0))
		const untried = minimum < 3 ? names.filter(name => (this.scores.get(name)?.attempts ?? 0) === minimum) : []
		const epsilon = this.options().exploration
		if (untried.length) {
			const total = untried.reduce((sum, name) => sum + this.prior(name), 0)
			return names.map(name => epsilon / names.length + (untried.includes(name) ? (1 - epsilon) * this.prior(name) / total : 0))
		}
		const weights = names.map(name => this.weight(name, now))
		const sum = weights.reduce((a, b) => a + b, 0)
		return weights.map(weight => epsilon / names.length + (1 - epsilon) * weight / sum)
	}
	pick<T extends { name: string }>(available: T[]): T | undefined {
		if (!this.options().enabled) return this.fallback.pick(available)
		const choices = this.order.flatMap(name => available.filter(choice => choice.name === name))
		if (!choices.length) return undefined
		if (this.focus && (this.clock() >= this.focus.expires || this.focus.remaining <= 0)) this.focus = undefined
		if (this.options().specialize !== false && this.focus && choices.every(choice => (this.scores.get(choice.name)?.attempts ?? 0) >= 3) && choices.some(choice => choice.name === this.focus!.name) && this.weight(this.focus.name, this.clock()) >= 1.5 * Math.max(1, ...choices.filter(choice => choice.name !== this.focus!.name).map(choice => this.weight(choice.name, this.clock())))) {
			this.focus.remaining--
			const draw = this.random(), epsilon = this.options().exploration
			return draw < 1 - epsilon ? choices.find(choice => choice.name === this.focus!.name) : choices[Math.min(choices.length - 1, Math.floor((draw - (1 - epsilon)) / epsilon * choices.length))]
		}
		const probabilities = this.probabilities(choices.map(choice => choice.name))
		let draw = this.random()
		for (let i = 0; i < choices.length; i++) { draw -= probabilities[i]; if (draw < 0) return choices[i] }
		return choices.at(-1)
	}
	observe(name: string, removed: number, elapsedMs: number) {
		const successes = removed > 0 ? (this.scores.get(name)?.successes ?? 0) + 1 : 0
		if (successes >= 3) this.focus = {name, misses: 0, remaining: 16, expires: this.clock() + 30000}
		else if (removed <= 0 && this.focus?.name === name && ++this.focus.misses >= 3) this.focus = undefined
		workerLearning?.observe(name, removed, elapsedMs)
		this.sharedRates.delete(name)
		const now = this.clock(), old = this.scores.get(name)
		const rate = Math.max(0, removed) * 1000 / Math.max(1, elapsedMs)
		this.scores.set(name, { value: old ? this.score(name, now) * 0.7 + rate * 0.3 : rate, updated: now, attempts: (old?.attempts ?? 0) + 1, successes })
	}
}
