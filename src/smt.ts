import { Gate } from './types.js'
import { evalCircuit, generateCombinations, isReplacementSimpler } from './utils.js'

// Each call owns its WASM instance; no concurrent access or surviving helper threads.
export async function synthesizeSMT(original: Gate[], wires: number, maxGates: number, timeoutMs: number): Promise<Gate[] | undefined> {
	const { init, killThreads } = await import('z3-solver')
	const api = await init()
	try {
		const { Solver, Int, Bool, Or, If, Xor } = new api.Context('synthesis')
		const end = performance.now() + timeoutMs
		const inputs = generateCombinations(wires)
		const expected = inputs.map(input => evalCircuit(original, input))
		for (let count = 0; count <= Math.min(maxGates, original.length - 1); count++) {
			const solver = new Solver()
			try {
				const slots = Array.from({ length: count }, (_, i) => ({ a: Int.const(`a${i}`), b: Int.const(`b${i}`), target: Int.const(`t${i}`), f: Int.const(`f${i}`) }))
				for (const slot of slots) solver.add(slot.a.ge(0), slot.a.lt(wires), slot.b.ge(0), slot.b.lt(wires), slot.target.ge(0), slot.target.lt(wires), slot.f.ge(0), slot.f.lt(16))
				const seen = new Set<number>()
				const addExample = (index: number) => {
					if (seen.has(index)) return
					seen.add(index)
					let state = inputs[index].map(value => Bool.val(value))
					for (const slot of slots) {
						const pick = (wire: typeof slot.a) => state.reduce((result, value, i) => If(wire.eq(i), value, result), state[0])
						const a = pick(slot.a), b = pick(slot.b)
						const bit = (mask: number) => Or(...Array.from({ length: 16 }, (_, f) => f).filter(f => f & mask).map(f => slot.f.eq(f)))
						const control = If(a, If(b, bit(1), bit(2)), If(b, bit(4), bit(8)))
						state = state.map((value, wire) => If(slot.target.eq(wire), Xor(value, control), value))
					}
					state.forEach((value, wire) => solver.add(value.eq(Bool.val(expected[index][wire]))))
				}
				addExample(0)
				addExample(inputs.length - 1)
				while (performance.now() < end) {
					solver.set('timeout', Math.max(1, Math.floor(end - performance.now())))
					const result = await solver.check()
					if (result !== 'sat') break
					const model = solver.model()
					const read = (term: typeof slots[number]['a']) => Number(model.eval(term, true).toString())
					const candidate = slots.map(slot => ({ a: read(slot.a), b: read(slot.b), target: read(slot.target), gate_i: read(slot.f) }))
					model.release()
					const counterexample = inputs.findIndex((input, i) => evalCircuit(candidate, input).some((value, wire) => value !== expected[i][wire]))
					if (counterexample < 0) return isReplacementSimpler(candidate, original) ? candidate : undefined
					addExample(counterexample)
				}
			} finally { solver.release() }
			if (performance.now() >= end) return undefined
		}
		return undefined
	} finally { await killThreads(api.em) }
}
