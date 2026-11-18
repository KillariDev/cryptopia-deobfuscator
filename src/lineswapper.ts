import { DependencyNode, Gate } from './types.js'
import { gateToText, getVars } from './utils.js'

export const createDependencyGraph = (gates: Gate[]) => {
	const dependencyGraph: DependencyNode[] = []
	const lastAccess = new Map<number, number>()
	const lastWrite = new Map<number, number>()
	for (let line = 0; line < gates.length; line++) {
		const wires = getVars(gates[line])
		const target = wires[0]
		const previous: number[] = []
		const targetAccess = lastAccess.get(target)
		if (targetAccess !== undefined) previous.push(targetAccess)
		for (let i = 1; i < wires.length; i++) {
			const writer = lastWrite.get(wires[i])
			if (writer !== undefined && !previous.includes(writer)) previous.push(writer)
		}
		if (previous.length > 1) previous.sort((a, b) => a - b)
		dependencyGraph.push({ lineNumber: line, dependOnPastLines: previous, dependOnFutureLine: -1 })
		for (const wire of wires) lastAccess.set(wire, line)
		lastWrite.set(target, line)
	}
	// Reuse the scratch maps to find the nearest future access/write.
	lastAccess.clear()
	lastWrite.clear()
	for (let i = gates.length - 1; i >= 0; i--) {
		const wires = getVars(gates[i])
		const target = wires[0]
		let next = lastAccess.get(target) ?? Infinity
		for (let j = 1; j < wires.length; j++) next = Math.min(next, lastWrite.get(wires[j]) ?? Infinity)
		dependencyGraph[i].dependOnFutureLine = next === Infinity ? -1 : next
		for (const wire of wires) lastAccess.set(wire, i)
		lastWrite.set(target, i)
	}
	return dependencyGraph
}


export const getDependencyGraphAsString = (dependencyGraph: DependencyNode[]) => {
	return dependencyGraph.map((x) => `${x.lineNumber}: [${ x.dependOnPastLines.join(',') }] -> ${ x.dependOnFutureLine }`).join('\n')
}
export const getDependencyGraphAsStringWithGates = (dependencyGraph: DependencyNode[], gates: Gate[]) => {
	return dependencyGraph.map((x) => `${x.lineNumber}: [${ x.dependOnPastLines.join(',') }] -> ${ x.dependOnFutureLine } | ${gateToText(gates[x.lineNumber])}`).join('\n')
}
export const getDependencyGraphAsEdgesString = (dependencyGraph: DependencyNode[]) => {
	return dependencyGraph.flatMap((x) => x.dependOnPastLines.map((l) => `a${x.lineNumber} a${ l }`)).join('\n')
}
