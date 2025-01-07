import { map } from 'd3'
import { DependencyNode } from './types.js'

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

export const findCriticalPathsForNodes = (nodes: DependencyNode[]): number[][] => {
	const nodeMap: Map<number, DependencyNode> = new Map()
	const memo: Map<number, number[]> = new Map()

	// Build a map for quick access by lineNumber
	for (const node of nodes) {
		nodeMap.set(node.lineNumber, node)
	}

	// Helper function to recursively find the longest path to a node
	const findLongestPath = (lineNumber: number): number[] => {
		if (memo.has(lineNumber)) {
			return memo.get(lineNumber) as number[]
		}

		const node = nodeMap.get(lineNumber)
		if (!node) {
			return []
		}

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

	for (const node of nodes) {
		criticalPaths.push(findLongestPath(node.lineNumber))
	}

	return criticalPaths
}

export function findLongestUniquePaths(data: number[][]): number[][] {
    const uniquePaths: number[][] = []

    // Iterate over the paths
    for (const path of data) {
        let isUnique = true

        // Compare with other paths
        for (const otherPath of uniquePaths) {
            // Check if the current path shares a prefix with any existing unique path
            if (isPrefix(path, otherPath)) {
                isUnique = false
                break
            }
            if (isPrefix(otherPath, path)) {
                // If the other path is a prefix, replace the shorter one
                const index = uniquePaths.indexOf(otherPath)
                if (index !== -1) {
                    uniquePaths.splice(index, 1)
                }
            }
        }

        // If the path is unique, add it
        if (isUnique) {
            uniquePaths.push(path)
        }
    }

    return uniquePaths
}

// Helper function to check if path1 is a prefix of path2
function isPrefix(path1: number[], path2: number[]): boolean {
    if (path1.length > path2.length) return false
    for (let i = 0; i < path1.length; i++) {
        if (path1[i] !== path2[i]) return false
    }
    return true
}
