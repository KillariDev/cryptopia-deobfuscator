import { areCircuitsProbabilisticallyTheSame, combineGates } from './processing.js'
import { Gate } from './types.js'
import { gatesToText, generateNRandomBooleanArray } from './utils.js'

const INPUTS = 202

const runTests = () => {
	const t1 = () => { 
		console.log('t1')
		const gates: Gate[] = [
			{ a: 1, b: 2, target: 0, gate_i: 1 },
			{ a: 1, b: 0, target: 0, gate_i: 3 },
		]
		const mappedGates = combineGates(gates)
		console.log(gatesToText(gates))
		console.log('to')
		console.log(gatesToText(mappedGates.gates))
		if (!areCircuitsProbabilisticallyTheSame([], gates, mappedGates.gates, INPUTS, 64)) throw new Error('mismatch')
	}
	t1()
	const t2 = () => { 
		console.log('t2')
		const gates: Gate[] = [
			{ a: 1, b: 0, target: 0, gate_i: 3 },
			{ a: 0, b: 0, target: 1, gate_i: 3 },
		]
		const mappedGates = combineGates(gates)
		console.log(gatesToText(gates))
		console.log('to')
		console.log(gatesToText(mappedGates.gates))
		if (!areCircuitsProbabilisticallyTheSame([], gates, mappedGates.gates, INPUTS, 64)) throw new Error('mismatch')
	}
	t2()

}

runTests()