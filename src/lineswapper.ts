import { DependencyNode, Gate } from "./types.js"
import { gateToText, getVars } from "./utils.js"

const setHasAny = (set: Set<number>, vars: number[]) => {
	for (const oneVar of vars) {
		if (set.has(oneVar)) return true
	}
	return false
}

// todo, some functions don't have both a&b vars or either
export function findSwappableLines(lines: Gate[], maxGroupSize: number, wires: number): number[][] {
	let currentLeftSideDependencies = new Set<number>()
	let currentRightSideDependencies = new Set<number>()
	let currentLines: number[] = []
	const groups: number[][] = [];
	const submitLines = () => {
		if (currentLines.length > 1) groups.push(currentLines)
		currentLines = []
		currentRightSideDependencies = new Set<number>()
		currentLeftSideDependencies = new Set<number>()
	}
	lines.forEach((line, index) => {
		const vars = getVars(line)
		const leftSide = vars[0]
		const rightSide = vars
		// the line depends on other if
		// 1) its left side has been used anywhere
		// 2) its right side has been used on left side
		if (setHasAny(currentRightSideDependencies, [leftSide]) || setHasAny(currentLeftSideDependencies, rightSide)) {
			submitLines()
		} else {
			rightSide.forEach((v) => currentRightSideDependencies.add(v))
			currentLeftSideDependencies.add(leftSide)
			currentLines.push(index)
			if (currentLines.length >= maxGroupSize) submitLines()
		}
	})
	return groups
}

function shuffleGroup(lines: Gate[], group: number[]): Gate[] {
	const shuffledLines = [...lines]
	for (let i = group.length - 1; i > 0; i--) {
		const j = Math.floor(Math.random() * (i + 1));
		[shuffledLines[group[i]], shuffledLines[group[j]]] = [shuffledLines[group[j]], shuffledLines[group[i]]];
	}
	return shuffledLines;
  }
  
export function shuffleLinesWithinGroups(lines: Gate[], groups: number[][]): Gate[] {
	let shuffledLines = [...lines]
	groups.forEach(group => {
		shuffledLines = shuffleGroup(shuffledLines, group);
	})
	return shuffledLines;
}

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
	return dependencyGraph.map((x) => `${x.lineNumber}: [${ x.dependOnPastLines.join(',') }] -> ${ x.dependOnFutureLine } = ${gateToText(gates[x.lineNumber])}`).join('\n')
}
export const getDependencyGraphAsEdgesString = (dependencyGraph: DependencyNode[]) => {
	return dependencyGraph.flatMap((x) => x.dependOnPastLines.map((l) => `a${x.lineNumber} a${ l }`)).join('\n')
}
