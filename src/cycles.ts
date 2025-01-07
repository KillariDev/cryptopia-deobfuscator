import { map } from 'd3'
import { DependencyNode } from './types.js'
import { hashNumberArray } from './utils.js'

export function* findAllTopologicalSorts(nodes: DependencyNode[]): Generator<number[]> {
	const graph = buildGraph(nodes)
	const inDegreeMap: { [key: number]: number } = {}
	const currentSort: number[] = []

	// Initialize in-degree map
	graph.forEach(node => {
		inDegreeMap[node.lineNumber] = 0
	})
	graph.forEach(node => {
		node.dependOnLines.forEach(dep => {
			inDegreeMap[dep]++
		})
	})

	// Backtracking function to generate all sorts
	function* backtrack(): Generator<number[]> {
		// Find all nodes with in-degree 0 (available to pick)
		const availableNodes = graph
			.filter(node => inDegreeMap[node.lineNumber] === 0 && !currentSort.includes(node.lineNumber))
			.map(node => node.lineNumber)

		// If no nodes are available and the sort is complete, yield it
		if (currentSort.length === graph.length) {
			yield [...currentSort]
			return
		}

		// Try each available node
		for (const node of availableNodes) {
			// Add node to current sort and adjust in-degree of its neighbors
			currentSort.push(node)
			for (const neighbor of graph.find(n => n.lineNumber === node)!.dependOnLines) {
				inDegreeMap[neighbor]--
			}

			// Recur to generate sorts with the current node
			yield* backtrack()

			// Backtrack: remove node and restore in-degrees
			currentSort.pop()
			for (const neighbor of graph.find(n => n.lineNumber === node)!.dependOnLines) {
				inDegreeMap[neighbor]++
			}
		}
	}

	yield* backtrack()
}

function buildGraph(nodes: DependencyNode[]): DependencyNode[] {
	const graph: DependencyNode[] = []
	const lineNumberToNodeMap: { [key: number]: DependencyNode } = {}

	for (const { lineNumber, dependOnLines } of nodes) {
		if (!lineNumberToNodeMap[lineNumber]) {
			lineNumberToNodeMap[lineNumber] = { lineNumber, dependOnLines: [] }
			graph.push(lineNumberToNodeMap[lineNumber])
		}
		for (const dep of dependOnLines) {
			if (!lineNumberToNodeMap[dep]) {
				lineNumberToNodeMap[dep] = { lineNumber: dep, dependOnLines: [] }
				graph.push(lineNumberToNodeMap[dep])
			}
			lineNumberToNodeMap[dep].dependOnLines.push(lineNumber)
		}
	}

	return graph
}

export function groupTopologicalSort(nodes: DependencyNode[]): number[] {
	const graph = buildGraph(nodes)
	const groupIds: { [key: number]: number } = {}
	const inDegreeMap: { [key: number]: number } = {}
	const nodeQueue: number[] = []

	// Initialize in-degree map and group IDs
	graph.forEach(node => {
		inDegreeMap[node.lineNumber] = 0
		groupIds[node.lineNumber] = 0
	})
	graph.forEach(node => {
		node.dependOnLines.forEach(dep => {
			inDegreeMap[dep]++
		})
	})

	// Find all root nodes (nodes with in-degree 0)
	graph.forEach(node => {
		if (inDegreeMap[node.lineNumber] === 0) {
			nodeQueue.push(node.lineNumber)
		}
	})

	// Handle the case of no root nodes
	if (nodeQueue.length === 0) {
		throw new Error('No root nodes found in graph.')
	}

	// Process the graph to assign group IDs
	while (nodeQueue.length > 0) {
		const currentNode = nodeQueue.shift()!

		// For each dependent node, update its group ID and process further
		for (const dep of graph.find(n => n.lineNumber === currentNode)!.dependOnLines) {
			groupIds[dep] = Math.max(groupIds[dep], groupIds[currentNode] + 1)
			inDegreeMap[dep]--

			if (inDegreeMap[dep] === 0) {
				nodeQueue.push(dep)
			}
		}
	}

	// Convert the group IDs to a 1D array in the order of node IDs
	const result: number[] = []
	nodes.forEach(node => {
		result.push(groupIds[node.lineNumber])
	})

	return result
}

export function findGroupsThatDoNotDependFromOthers(nodes: DependencyNode[]): number[][] {
	console.log('findGroupsThatDoNotDependFromOthers')
	const findAllThatDepend = (lineNumber: number) => {
		let dependents: DependencyNode[] = []
		for (const node of nodes) {
			if(node.dependOnLines.indexOf(lineNumber) >= 0) {
				dependents = [...dependents, node] 
			}
		}
		return dependents
	}
	let groups: number[][] = []
	const knownGroups = new Map<number, number[]>()
	
	for (const node of nodes) {
		const a = node.dependOnLines
		const deps = Array.from(new Set(a.flatMap((x) => findAllThatDepend(x)).map((x) => x.lineNumber))).sort((a, b) => a - b)
		const getMidDependnceis = deps.filter((x) => !(x >= node.lineNumber || node.dependOnLines.indexOf(x) >= 0))
		const newGroup = [node.lineNumber, ...node.dependOnLines, ...getMidDependnceis]
		newGroup.forEach((x) => {
			const known = knownGroups.get(x)
			if (known) newGroup.push(...known)
		})
		const arranged = Array.from(new Set(newGroup)).sort((a, b) => a - b)
		knownGroups.set(node.lineNumber, arranged)
		groups = [...groups, arranged]
	}
	console.log('d')
	return groups
}

/*
export const findCriticalPathsForNodes = (nodes: DependencyNode[]): number[][] => {
	const nodeMap: Map<number, DependencyNode> = new Map()
	const memo: Map<number, number[]> = new Map()

	// Build a map for quick access by lineNumber
	for (const node of nodes) {
		nodeMap.set(node.lineNumber, node)
	}

	// Helper function to recursively find the longest path to a node
	const findLongestPath = (lineNumber: number): number[] => {
		if (memo.has(lineNumber)) return memo.get(lineNumber) as number[]

		const node = nodeMap.get(lineNumber)
		if (!node) return []

		let longestPath: number[] = []

		for (const dep of node.dependOnLines) {
			const path = findLongestPath(dep)
			if (path.length > longestPath.length) {
				longestPath = path
			}
		}

		const result = Array.from(new Set([...longestPath, ...node.dependOnLines, lineNumber])).sort((a, b) => a - b)
		memo.set(lineNumber, result)
		return result
	}

	// Create an array to store the critical path for each node
	const criticalPaths: number[][] = []

	let iterator = 0
	for (const node of nodes) {
		if (iterator % 100) console.log(`CriticalPaths${iterator / nodes.length*100}%`)
		iterator++
		criticalPaths.push(findLongestPath(node.lineNumber))
	}

	return criticalPaths
}
*/

export const findCriticalPath = (nodes: DependencyNode[]): number[] => {
	const n = nodes.length
	const pathLengths: number[] = new Array(n).fill(0)
	const parents: number[] = new Array(n).fill(-1)

	for (let i = 0; i < n; i++) {
		const currentNode = nodes[i]
		const dependencies = currentNode.dependOnLines

		// If the node has no dependencies, it has a path length of 1 (itself)
		if (dependencies.length === 0) {
			pathLengths[i] = 1
		} else {
			// Otherwise, find the longest path from the dependencies
			let maxPathLength = 0
			let maxDependency = -1
			for (const dependencyIndex of dependencies) {
				if (pathLengths[dependencyIndex] > maxPathLength) {
					maxPathLength = pathLengths[dependencyIndex]
					maxDependency = dependencyIndex
				}
			}
			// The path length of this node is 1 (itself) + the longest path length of its dependencies
			pathLengths[i] = 1 + maxPathLength
			// Record the parent node in the critical path
			parents[i] = maxDependency
		}
	}

	// Stack-based iterative method to collect the critical path
	const criticalPath: number[] = []
	const visited = new Set<number>()

	// Start from the last node (the last element in the array)
	let currentNodeIndex = n - 1

	// Use a stack to store the nodes and traverse their dependencies
	const stack: number[] = [currentNodeIndex, ...nodes[currentNodeIndex].dependOnLines]

	while (stack.length > 0) {
		const nodeIndex = stack[stack.length - 1]
		const node = nodes[nodeIndex]

		// If this node has been fully processed (all dependencies are collected), add it to the critical path
		if (visited.has(nodeIndex)) {
			// Add the current node to the critical path
			criticalPath.push(node.lineNumber)
			stack.pop()
		} else {
			// If not yet processed, push its dependencies to the stack
			for (const dependencyIndex of node.dependOnLines) {
				if (!visited.has(dependencyIndex)) {
					stack.push(dependencyIndex)
				}
			}
			// Mark the current node as visited for when we revisit it
			visited.add(nodeIndex)
		}
	}
	
	return Array.from(new Set(criticalPath)).sort((a, b) => a - b)
}

export const findCriticalPathsForNodes = (nodes: DependencyNode[]): number[][] => {
	const nodeMap: Map<number, DependencyNode> = new Map()
	const inDegrees: Map<number, number> = new Map()
	const adjList: Map<number, number[]> = new Map()
	const pathLengths: Map<number, number> = new Map()

	// Build adjacency list and track in-degrees
	for (const node of nodes) {
		nodeMap.set(node.lineNumber, node)
		inDegrees.set(node.lineNumber, 0)
		adjList.set(node.lineNumber, [])
	}

	for (const node of nodes) {
		for (const dep of node.dependOnLines) {
			adjList.get(dep)?.push(node.lineNumber)
			inDegrees.set(node.lineNumber, (inDegrees.get(node.lineNumber) || 0) + 1)
		}
	}

	// Perform topological sort
	const queue: number[] = []
	for (const [lineNumber, degree] of inDegrees.entries()) {
		if (degree === 0) queue.push(lineNumber)
	}

	// Process nodes in topological order
	while (queue.length > 0) {
		const current = queue.shift() as number
		if (current % 100) console.log(`CriticalPaths${current / nodes.length*100}%`)
		const currentLength = pathLengths.get(current) || 0

		for (const neighbor of adjList.get(current) || []) {
			// Update the longest path length for the neighbor
			const neighborLength = pathLengths.get(neighbor) || 0
			pathLengths.set(neighbor, Math.max(neighborLength, currentLength + 1))

			// Decrement in-degree and enqueue if it reaches 0
			const updatedDegree = (inDegrees.get(neighbor) || 1) - 1
			inDegrees.set(neighbor, updatedDegree)
			if (updatedDegree === 0) {
				queue.push(neighbor)
			}
		}
	}
	console.log(`rebuild`)

	// Rebuild critical paths
	const criticalPaths: number[][] = []
	for (const node of nodes) {
		const path: number[] = []
		let current = node.lineNumber
		if (current % 100) console.log(`rebuilding${current / nodes.length*100}%`)

		while (pathLengths.has(current)) {
			path.push(current)

			let nextNode = null
			let maxLength = -1

			for (const dep of nodeMap.get(current)?.dependOnLines || []) {
				const depLength = pathLengths.get(dep) || 0
				if (depLength > maxLength) {
					maxLength = depLength
					nextNode = dep
				}
			}

			if (nextNode === null) break
			current = nextNode
		}

		path.reverse()
		criticalPaths.push(path)
	}

	return criticalPaths
}

export function findLongestUniquePaths(data: number[][]): number[][] {
	const uniquePaths: number[][] = []
	let iterator = 0
	for (const path of data) {
		let shouldAdd = true
		if (iterator % 100) console.log(`Unique criticals ${iterator / data.length*100}%`)
		iterator++

		for (let i = 0; i < uniquePaths.length; i++) {
			const otherPath = uniquePaths[i]
			const result = checkPrefixRelationship(path, otherPath)

			if (result === 'prefix') {
				// Path is a prefix of otherPath; it's not unique
				shouldAdd = false
				break
			} else if (result === 'superset') {
				// OtherPath is a prefix of path; remove otherPath
				uniquePaths.splice(i, 1)
				i-- // Adjust index after removal
			}
		}

		if (shouldAdd) {
			uniquePaths.push(path)
		}
	}

	return uniquePaths
}

// Helper function to check the prefix relationship
function checkPrefixRelationship(path1: number[], path2: number[]): 'prefix' | 'superset' | 'none' {
	const minLength = Math.min(path1.length, path2.length)

	for (let i = 0; i < minLength; i++) {
		if (path1[i] !== path2[i]) {
			return 'none'
		}
	}

	if (path1.length === path2.length) {
		return 'none' // Paths are identical, so neither is a prefix
	}

	return path1.length < path2.length ? 'prefix' : 'superset'
}

export const findUniqueCriticalPaths = (nodes: DependencyNode[]): number[][] => {
	const nodeMap: Map<number, DependencyNode> = new Map()
	const inDegrees: Map<number, number> = new Map()
	const adjList: Map<number, number[]> = new Map()
	const pathLengths: Map<number, number> = new Map()
	const longestPaths: Map<number, number[]> = new Map()  // Tracks the longest path for each node

	// Build adjacency list and track in-degrees
	for (const node of nodes) {
		nodeMap.set(node.lineNumber, node)
		inDegrees.set(node.lineNumber, 0)
		adjList.set(node.lineNumber, [])
	}

	for (const node of nodes) {
		for (const dep of node.dependOnLines) {
			adjList.get(dep)?.push(node.lineNumber)
			inDegrees.set(node.lineNumber, (inDegrees.get(node.lineNumber) || 0) + 1)
		}
	}

	// Perform topological sort
	const queue: number[] = []
	for (const [lineNumber, degree] of inDegrees.entries()) {
		if (degree === 0) queue.push(lineNumber)
	}

	// Process nodes in topological order
	while (queue.length > 0) {
		const current = queue.shift() as number
		const currentLength = pathLengths.get(current) || 0

		for (const neighbor of adjList.get(current) || []) {
			// Update the longest path length for the neighbor
			const neighborLength = pathLengths.get(neighbor) || 0
			if (currentLength + 1 > neighborLength) {
				pathLengths.set(neighbor, currentLength + 1)
				// Build the path incrementally
				longestPaths.set(neighbor, [...(longestPaths.get(current) || []), current])
			}

			// Decrement in-degree and enqueue if it reaches 0
			const updatedDegree = (inDegrees.get(neighbor) || 1) - 1
			inDegrees.set(neighbor, updatedDegree)
			if (updatedDegree === 0) {
				queue.push(neighbor)
			}
		}
	}

	// Keep only unique critical paths
	const uniquePaths: Set<string> = new Set() // Use a Set to store unique path representations
	const finalPaths = []
	// For each node, build the critical path and store its unique representation
	for (const node of nodes) {
		const path = [...(longestPaths.get(node.lineNumber) || []), node.lineNumber]
		const pathString = hashNumberArray(path)

		if (!uniquePaths.has(pathString)) {
			uniquePaths.add(pathString) // Only add unique paths
			finalPaths.push(path)
			console.log(finalPaths.length)
		}
	}

	return finalPaths
}