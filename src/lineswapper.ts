import { DependencyNode, Gate } from "./types.js"
import { gateToText, getVars } from "./utils.js"

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
		const dependOnFuture = gates.slice(currentLineNumber + 1).findIndex((futureLine) => {
			const futureVars = getVars(futureLine)
			const futureTarget = futureVars[0]
			return futureVars.includes(target) || rest.includes(futureTarget)
		})
		dependencyGraph.push({
			lineNumber: currentLineNumber,
			dependOnPastLines: Array.from(new Set([...targetDepends ? [targetDepends] : [], ...restDepends])).sort((a, b) => a - b),
			dependOnFutureLine: dependOnFuture < 0 ? dependOnFuture : dependOnFuture + currentLineNumber +1,
		})
		vars.forEach((x) => variableDependedLast.set(x, currentLineNumber))
		variableSetLast.set(vars[0], currentLineNumber)
	})
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
