// Scan-based subset selection retained only as a regression oracle.
import { Gate, DependencyNode } from './types.js'
import { getVars } from './utils.js'
class SortedArray {
	private elements: number[] = []

	// Add one or multiple numbers to the sorted array
	add(nums: number | number[]): void {
		if (!Array.isArray(nums)) {
			nums = [nums]
		}

		// Deduplicate and filter out existing elements
		const uniqueNums = [...new Set(nums)].filter(num => !this.contains(num))

		// Merge the new numbers into the sorted array
		for (const num of uniqueNums) {
			let left = 0
			let right = this.elements.length

			// Binary search for the correct position
			while (left < right) {
				const mid = Math.floor((left + right) / 2)
				if (this.elements[mid] < num) {
					left = mid + 1
				} else {
					right = mid
				}
			}

			// Insert the number at the correct position
			this.elements.splice(left, 0, num)
		}
	}

	// Check if the array contains a number
	private contains(num: number): boolean {
		let left = 0
		let right = this.elements.length - 1

		// Binary search for the number
		while (left <= right) {
			const mid = Math.floor((left + right) / 2)
			if (this.elements[mid] === num) {
				return true
			} else if (this.elements[mid] < num) {
				left = mid + 1
			} else {
				right = mid - 1
			}
		}

		return false
	}

	// Remove and return the smallest element
	popMin(): number | undefined {
		return this.elements.shift()
	}

	// Remove and return the largest element
	popMax(): number | undefined {
		return this.elements.pop()
	}

	// Get the sorted elements (read-only)
	get values(): readonly number[] {
		return this.elements
	}
}


const getAllFutureDependencies = (futureDependsCache: Map<number, number[]>, currentNode: DependencyNode, subsetSet: Set<number>, maxNodeNumber: number, gates: Gate[]) => {
	const cache = futureDependsCache.get(currentNode.lineNumber)
	if (cache) return cache
	if (currentNode.dependOnFutureLine === -1) return []
	if (currentNode.dependOnFutureLine >= maxNodeNumber) return []
	const currentGate = gates[currentNode.lineNumber]
	const vars = getVars(currentGate)
	const target = vars[0]
	const rest = vars.slice(1)
	const depends: number[] = []
	for (let index = currentNode.dependOnFutureLine; index < maxNodeNumber; index++) {
		if (subsetSet.has(index)) continue
		const futureLine = gates[index]
		const futureVars = getVars(futureLine)
		const futureTarget = futureVars[0]
		if (futureVars.includes(target) || rest.includes(futureTarget)) {
			depends.push(index)
		}
	}
	futureDependsCache.set(currentNode.lineNumber, depends)
	return depends
}

function needToAddAsWell(dependantMap: Map<number, number[]>, subset: number[], subsetSet: Set<number>, node: number, maxNodeNumber: number, nodes: DependencyNode[], gates: Gate[]): { pastDepend: number[], addNode: number } {
	const futureDependsCache = new Map<number, number[]>()
	let currentNode = node
	while(true) {
		const requirements = getAllFutureDependencies(futureDependsCache, nodes[currentNode], subsetSet, maxNodeNumber, gates)
		if (requirements.length === 0) {
			const depends = dependantMap.get(currentNode) || []
			return {
				pastDepend: depends.filter((x) => !subset.includes(x) && x < maxNodeNumber),
				addNode: currentNode
			}
		} else {
			currentNode = requirements[requirements.length - 1]
		}
	}
}

export const referenceDependencySort = (dependantMap: Map<number, number[]>, node: DependencyNode, maxLength: number, nodes: DependencyNode[], gates: Gate[]) => {
	const currentSubset: number[] = []
	const currentSubsetSet = new Set<number>()
	let nonExploredDepenencies = new SortedArray()
	currentSubset.push(node.lineNumber)
	currentSubsetSet.add(node.lineNumber)
	nonExploredDepenencies.add(node.dependOnPastLines)
	while (true) {
		const candidate = nonExploredDepenencies.popMin()
		if (candidate === undefined) break
		if (currentSubsetSet.has(candidate)) continue
		const needToAdd = needToAddAsWell(dependantMap, currentSubset, currentSubsetSet, candidate, node.lineNumber, nodes, gates)
		if (needToAdd.pastDepend.length > 0) {
			nonExploredDepenencies.add([candidate, ...needToAdd.pastDepend]) //push us pack with the new deps
			continue
		}
		if (needToAdd.addNode !== candidate) {
			nonExploredDepenencies.add(candidate)
		}
		currentSubset.push(needToAdd.addNode)
		if (currentSubset.length >= maxLength) break
		currentSubsetSet.add(needToAdd.addNode)
		nonExploredDepenencies.add(nodes[needToAdd.addNode].dependOnPastLines.filter((x) => !currentSubsetSet.has(x)))
	}
	return currentSubset.slice().reverse()
}

