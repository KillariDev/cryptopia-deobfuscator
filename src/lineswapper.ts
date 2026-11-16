import { DependencyNode, Gate } from './types.js'
import { gateToText, getVars } from './utils.js'

export const createDependencyGraph = (gates: Gate[]) => {
	const dependencyGraph: DependencyNode[] = []
	const variableDependedLast = new Map<number, number>() // <variable, line>
	const variableSetLast = new Map<number, number>() // <variable, line>
	gates.forEach((line, currentLineNumber) => {
		const vars = getVars(line)
		const target = vars[0]
		const rest = vars.slice(1)
		const targetDepends = variableDependedLast.get(target)
		const restDepends = rest.map((variable) => variableSetLast.get(variable)).filter((variableOrUndefined): variableOrUndefined is number => variableOrUndefined !== undefined)

		dependencyGraph.push({
			lineNumber: currentLineNumber,
			dependOnPastLines: Array.from(new Set([...(targetDepends !== undefined ? [targetDepends] : []), ...restDepends])).sort((a, b) => a - b),
			dependOnFutureLine: -1,
		})
		vars.forEach((x) => variableDependedLast.set(x, currentLineNumber))
		variableSetLast.set(vars[0], currentLineNumber)
	})
	// Nearest future access to our target, or write to any control wire.
	const nextAccess = new Map<number, number>()
	const nextWrite = new Map<number, number>()
	for (let i = gates.length - 1; i >= 0; i--) {
		const [target, ...controls] = getVars(gates[i])
		let next = nextAccess.get(target) ?? Infinity
		for (const wire of controls) next = Math.min(next, nextWrite.get(wire) ?? Infinity)
		dependencyGraph[i].dependOnFutureLine = next === Infinity ? -1 : next
		for (const wire of [target, ...controls]) nextAccess.set(wire, i)
		nextWrite.set(target, i)
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
