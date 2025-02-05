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
		node.dependOnPastLines.forEach(dep => {
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
			for (const neighbor of graph.find(n => n.lineNumber === node)!.dependOnPastLines) {
				inDegreeMap[neighbor]--
			}

			// Recur to generate sorts with the current node
			yield* backtrack()

			// Backtrack: remove node and restore in-degrees
			currentSort.pop()
			for (const neighbor of graph.find(n => n.lineNumber === node)!.dependOnPastLines) {
				inDegreeMap[neighbor]++
			}
		}
	}

	yield* backtrack()
}

function buildGraph(nodes: DependencyNode[]): DependencyNode[] {
	const graph: DependencyNode[] = []
	const lineNumberToNodeMap: { [key: number]: DependencyNode } = {}

	for (const { lineNumber, dependOnPastLines } of nodes) {
		if (!lineNumberToNodeMap[lineNumber]) {
			lineNumberToNodeMap[lineNumber] = { lineNumber, dependOnPastLines: [], dependOnFutureLine: -1 }
			graph.push(lineNumberToNodeMap[lineNumber])
		}
		for (const dep of dependOnPastLines) {
			if (!lineNumberToNodeMap[dep]) {
				lineNumberToNodeMap[dep] = { lineNumber: dep, dependOnPastLines: [], dependOnFutureLine: -1 }
				graph.push(lineNumberToNodeMap[dep])
			}
			lineNumberToNodeMap[dep].dependOnPastLines.push(lineNumber)
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
		node.dependOnPastLines.forEach(dep => {
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
		for (const dep of graph.find(n => n.lineNumber === currentNode)!.dependOnPastLines) {
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
			if(node.dependOnPastLines.indexOf(lineNumber) >= 0) {
				dependents = [...dependents, node] 
			}
		}
		return dependents
	}
	let groups: number[][] = []
	const knownGroups = new Map<number, number[]>()
	
	for (const node of nodes) {
		const a = node.dependOnPastLines
		const deps = Array.from(new Set(a.flatMap((x) => findAllThatDepend(x)).map((x) => x.lineNumber))).sort((a, b) => a - b)
		const getMidDependnceis = deps.filter((x) => !(x >= node.lineNumber || node.dependOnPastLines.indexOf(x) >= 0))
		const newGroup = [node.lineNumber, ...node.dependOnPastLines, ...getMidDependnceis]
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

		for (const dep of node.dependOnPastLines) {
			const path = findLongestPath(dep)
			if (path.length > longestPath.length) {
				longestPath = path
			}
		}

		const result = Array.from(new Set([...longestPath, ...node.dependOnPastLines, lineNumber])).sort((a, b) => a - b)
		memo.set(lineNumber, result)
		return result
	}

	// Create an array to store the critical path for each node
	const criticalPaths: number[][] = []

	let iterator = 0
	for (const node of nodes) {
		iterator++
		criticalPaths.push(findLongestPath(node.lineNumber))
	}

	return criticalPaths
}


export const findCriticalPath = (nodes: DependencyNode[]): number[] => {
	const n = nodes.length
	const pathLengths: number[] = new Array(n).fill(0)
	const parents: number[] = new Array(n).fill(-1)

	// First, calculate the longest path lengths and parent dependencies
	for (let i = 0; i < n; i++) {
		const currentNode = nodes[i]
		const dependencies = currentNode.dependOnPastLines

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

	// Now, we'll backtrack starting from the last node (n - 1)
	const criticalPath: number[] = []
	const visited = new Set<number>()
	const stack: number[] = [n - 1] // Start with the last node in the stack
	const inProgress = new Set<number>() // Tracks nodes that are being processed

	// Use a while loop to simulate recursion
	while (stack.length > 0) {
		const nodeIndex = stack[stack.length - 1]
		const node = nodes[nodeIndex]

		// If the node is already fully processed (added to the path), pop it and continue
		if (visited.has(nodeIndex)) {
			stack.pop()
			continue
		}

		// If the node is in progress, it means all its dependencies are processed
		if (inProgress.has(nodeIndex)) {
			// Add the node to the critical path
			criticalPath.push(node.lineNumber)
			visited.add(nodeIndex)
			stack.pop()
		} else {
			// Mark the node as in progress and push its dependencies to the stack
			inProgress.add(nodeIndex)

			// Push all dependencies of the current node to the stack
			for (const dependencyIndex of node.dependOnPastLines) {
				if (!visited.has(dependencyIndex) && !inProgress.has(dependencyIndex)) {
					stack.push(dependencyIndex)
				}
			}
		}
	}

	// Return the critical path in the correct order (from start to end)
	return criticalPath
}

export function findLongestUniquePaths(data: number[][]): number[][] {
	const uniquePaths: number[][] = []
	for (const path of data) {
		let shouldAdd = true

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
		for (const dep of node.dependOnPastLines) {
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
		}
	}

	return finalPaths
}