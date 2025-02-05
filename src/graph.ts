//import { Gate } from './types.js'
//import { getVars } from './utils.js'

export const getVars = (gate: Gate) => {
	switch(gate.gate_i) {
		case 0: return [gate.target] // return false 
		case 1: return [gate.target, gate.a, gate.b] // return a && b
		case 2: return [gate.target, gate.a, gate.b] // return a && !b
		case 3: return [gate.target, gate.a] // return a//
		case 4: return [gate.target, gate.a, gate.b] // return !a && b
		case 5: return [gate.target, gate.b] // return b
		case 6: return [gate.target, gate.a, gate.b] // return xor(a,b)
		case 7: return [gate.target, gate.a, gate.b] // return a || b
		case 8: return [gate.target, gate.a, gate.b] // return !(a || b)
		case 9: return [gate.target, gate.a, gate.b] // return (a && b) || ((!a) && (!b))
		case 10: return [gate.target, gate.b] // return !b
		case 11: return [gate.target, gate.a, gate.b] // return (!b) || a
		case 12: return [gate.target, gate.a] // return !a
		case 13: return [gate.target, gate.a, gate.b] // return (!a) || b
		case 14: return [gate.target, gate.a, gate.b] // return !(a && b)
		case 15: return [gate.target] // return true
		default: throw new Error(`invalid control function: ${ gate.gate_i }`)
	}
}

export type Gate = {
	a: number
	b: number
	target: number
	gate_i: number
}

export type GateWithDependencies = {
	gateId: number,
	dependOnPastGates: number[]
	dependOnFutureGate: number | undefined
	otherGatesDepend: number[]
	gate: Gate
}

export type GateGraph = {
	dependencyGraph: Map<number, GateWithDependencies>
	maxGateId: number
}

export const createDependencyGraph = (gates: Gate[]): GateGraph => {
	const graph: GateGraph = {
		dependencyGraph: new Map <number,GateWithDependencies>(),
		maxGateId: gates.length
	}
	const variableDependedLast = new Map<number, number>() // <variable, line>
	const variableSetLast = new Map<number, number>() // <variable, line>
	gates.forEach((line, currentLineNumber) => {
		const vars = getVars(line)
		const target = vars[0]
		const rest = vars.slice(1)
		const targetDepends = variableDependedLast.get(target)
		const restDepends = rest.map((variable) => variableSetLast.get(variable)).filter((variableOrUndefined): variableOrUndefined is number => variableOrUndefined !== undefined)
		const dependOnFuture = gates.slice(currentLineNumber + 1).findIndex((futureLine) => {
			const futureVars = getVars(futureLine)
			const futureTarget = futureVars[0]
			return futureVars.includes(target) || rest.includes(futureTarget)
		})
		const newNode = {
			gateId: currentLineNumber,
			dependOnPastGates: Array.from(new Set([...targetDepends ? [targetDepends] : [], ...restDepends])).sort((a, b) => a - b),
			dependOnFutureGate: dependOnFuture < 0 ? undefined : dependOnFuture + currentLineNumber + 1,
			gate: line,
			otherGatesDepend: [],
		}
		graph.dependencyGraph.set(currentLineNumber, newNode)
		vars.forEach((x) => variableDependedLast.set(x, currentLineNumber))
		variableSetLast.set(vars[0], currentLineNumber)
	})

	// add othergatedependendencies
	gates.forEach((_, currentLineNumber) => {
		const gate = graph.dependencyGraph.get(currentLineNumber)
		if (gate === undefined) throw new Error('gate not found')
		if (gate.dependOnFutureGate !== undefined) {
			const future = graph.dependencyGraph.get(gate.dependOnFutureGate)
			if (future !== undefined) future.otherGatesDepend.push(currentLineNumber)
		}
		gate.dependOnPastGates.forEach((x) => {
			const past = graph.dependencyGraph.get(x)
			if (past !== undefined) past.otherGatesDepend.push(currentLineNumber)
		})
	})

	return graph
}

export const replaceGates = (gateGraph: GateGraph, gateIdsToReplace: number[], newGates: Gate[]) => {
	const oldGates = gateIdsToReplace.map((x) => gateGraph.dependencyGraph.get(x)).filter((x): x is GateWithDependencies => x !== undefined)
	const allOldDependencies = oldGates.flatMap((x) => [x.dependOnFutureGate, ...x.dependOnPastGates, ...x.otherGatesDepend]).filter((x): x is number => x !== undefined)
	const allOldDependenciesWithoutInternals = allOldDependencies.filter((x) => !oldGates.find((o) => o.gateId === x))
	let newGateIds: number[] = []
	gateIdsToReplace.forEach((x) => gateGraph.dependencyGraph.delete(x))
	newGates.forEach((newGate) => {
		gateGraph.maxGateId++
		gateGraph.dependencyGraph.set(gateGraph.maxGateId, {
			gateId: gateGraph.maxGateId,
			dependOnPastGates: [],
			dependOnFutureGate: undefined,
			otherGatesDepend: [],
			gate: newGate,
		})
		newGateIds.push(gateGraph.maxGateId)
	})
	// old gates to refresh
	const gatesToRefresh = Array.from(new Set(allOldDependenciesWithoutInternals))
	gatesToRefresh.forEach((gateId) => {
		const refreshGate = gateGraph.dependencyGraph.get(gateId)
		if (refreshGate === undefined) throw new Error('did not find id')
		if (refreshGate.dependOnFutureGate !== undefined && allOldDependencies.includes(refreshGate.dependOnFutureGate)) {
			//future gate is in old dependencies
		}
	})
}

export const convertToGates = (gateGraph: GateGraph): Gate[] => {
	return []
}