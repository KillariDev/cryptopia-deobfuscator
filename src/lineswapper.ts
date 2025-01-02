import { getVars } from "./utils";

type Gate = {
	a: number;
	b: number;
	target: number;
	gate_i: number;
}

const setHasAny = (set: Set<number>, vars: number[]) => {
	for (const oneVar of vars) {
		if (set.has(oneVar)) return true
	}
	return false
}

// todo, some functions don't have both a&b vars or either
export function findSwappableLines(lines: Gate[], maxGroupSize: number): number[][] {
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