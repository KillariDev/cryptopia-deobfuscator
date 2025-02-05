import { createCanvas } from 'canvas'
import * as fs from 'fs'
import * as d3 from 'd3'
import { DependencyNode, Gate } from './types.js'
import { createDependencyGraph } from './lineswapper.js'
import { groupTopologicalSort } from './cycles.js'
import { gateToText } from './utils.js'

interface D3Node extends d3.SimulationNodeDatum {
	id: number
}

interface D3Link extends d3.SimulationLinkDatum<D3Node> {
	source: number
	target: number
}

function scaleNodesToFit(nodes: D3Node[], width: number, height: number, padding: number): void {
	const minX = d3.min(nodes, d => d.x!)!;
	const minY = d3.min(nodes, d => d.y!)!;
	nodes.forEach(node => {
		node.x = (node.x! - minX);
		node.y = (node.y! - minY);
	});
	const maxX = d3.max(nodes, d => d.x!)!;
	const maxY = d3.max(nodes, d => d.y!)!;
	
	// Calculate scaling factors
	const scaleFactorX = (width - padding * 2) / (maxX);
	const scaleFactorY = (height - padding * 2) / (maxY);
  
	// Apply scaling to node positions
	nodes.forEach(node => {
	  node.x = (node.x!) * scaleFactorX + padding;
	  node.y = (node.y!) * scaleFactorY + padding;
	});
  }

export function drawDependencyGraph(gates: Gate[], outputFilePath: string, width: number, height: number): void {
	console.log('drawDependencyGraph')
	const dependencyData = createDependencyGraph(gates)
	// Create a canvas for rendering
	const canvas = createCanvas(width, height)
	const context = canvas.getContext('2d')

	// Background color
	context.fillStyle = '#f5f5f5'
	context.fillRect(0, 0, width, height)

	// Prepare nodes and links for the simulation
	const nodes: D3Node[] = dependencyData.map(node => ({
		id: node.lineNumber,
		x: node.lineNumber,
		y: 0
	}))

	const links: D3Link[] = dependencyData.flatMap(node =>
		[...node.dependOnPastLines.map(target => ({
			source: node.lineNumber,
			target: target,
			strength: 0.7
		})), ...node.dependOnFutureLine !== -1 ? [{
			source: node.dependOnFutureLine,
			target: node.lineNumber,
			strength: 0.1
		}] : []]
	)

	const padding = 20
	const area = (height-padding*2)*(width-padding*2)
	const preferredDist = area/(nodes.length*nodes.length)
	// Initialize the force simulatio
	const simulation = d3.forceSimulation<D3Node>(nodes)
		.force('link', d3.forceLink<D3Node, D3Link>(links).id(d => d.id).distance(preferredDist))
		.force("charge", d3.forceManyBody().distanceMax(preferredDist*40))
		.force("charge", d3.forceCollide(preferredDist / 2))
		.stop()

	// Run the simulation to compute node positions
	for (let i = 0; i < 20; ++i) {
		for (let a = 0; a < 100; ++a) {
			simulation.tick()
		}
		scaleNodesToFit(nodes, width, height, padding)
	}

	// Draw links
	context.strokeStyle = '#aaa'
	links.forEach(link => {
		const source = nodes.find(node => node.id === (link.source as any).id)
		const target = nodes.find(node => node.id === (link.target as any).id)
		if (source && target) {
			context.beginPath()
			context.moveTo(source.x!, source.y!)
			context.lineTo(target.x!, target.y!)
			context.stroke()
		} else {
			throw new Error('Link not found')
		}
	})

	// Draw nodes
	nodes.forEach(node => {
		context.fillStyle = '#007BFF'  // Blue node color
		context.beginPath()
		context.arc(node.x!, node.y!, 5, 0, 2 * Math.PI)
		context.fill()
		context.fillStyle = '#333' // Black text color
		context.fillText(`${ node.id }: ${ gateToText(gates[node.id]) }`, node.x! + 8, node.y! + 3)
	})

	// Save the canvas as an image file
	const buffer = canvas.toBuffer('image/png')
	fs.writeFileSync(outputFilePath, buffer)
	console.log(`Graph saved to ${outputFilePath}`)
}
