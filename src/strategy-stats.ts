export type StrategyStat = { strategy: string, settings: string, attempts: number, rewrites: number, gatesRemoved: number, elapsedMs: number }
const stats = new Map<string, StrategyStat>()
export const resetStrategyStats = () => stats.clear()
export const strategySnapshot = (): StrategyStat[] => [...stats.values()].map(value => ({ ...value }))
export function recordStrategy(strategy: string, settings: object, started: number, before: number, after: number, changed: boolean) {
	const detail = JSON.stringify(settings), key = `${strategy}:${detail}`
	const stat = stats.get(key) ?? { strategy, settings: detail, attempts: 0, rewrites: 0, gatesRemoved: 0, elapsedMs: 0 }
	stat.attempts++; stat.rewrites += Number(changed); stat.gatesRemoved += Math.max(0, before - after); stat.elapsedMs += performance.now() - started
	stats.set(key, stat)
}
