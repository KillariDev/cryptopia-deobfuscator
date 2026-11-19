// Run after npx tsc and generating data/rare-product.json.
import { readFileSync } from 'node:fs'
import { config } from '../dist/config.js'
import { WorkerPool } from '../dist/threads.js'
import { emitBorrowedProduct, synthesizeDecisionDiagramProduct } from '../dist/decision-diagram-product.js'

const { gates: tuples } = JSON.parse(readFileSync(new URL('../data/rare-product.json', import.meta.url)))
const rare = tuples.map(([a, b, target, gate_i]) => ({ a, b, target, gate_i }))
const relabel = (gates, wire) => gates.map(({ a, b, target, gate_i }) =>
	({ a: wire(a), b: wire(b), target: wire(target), gate_i }))
const restoredWrites = Array.from({ length: 39 }, (_, i) => ({ a: 0, b: 0, target: 38 - i, gate_i: 15 }))
	.flatMap(gate => [gate, gate])

// A product of pairwise XORs favors orders that keep each pair adjacent.
// Restoring the basis on either side of the payload makes both masks cancel.
const width = 18
const left = Array.from({ length: width }, (_, i) => i)
const right = left.map(i => i + width)
const scratch = left.slice(2).map((_, i) => i + 2 * width)
const target = 3 * width - 2
const basis = left.map((a, i) => ({ a, b: a, target: right[i], gate_i: 3 }))
const mask = [...basis, ...emitBorrowedProduct(right, scratch, target), ...basis.toReversed()]
const payload = emitBorrowedProduct(left.slice(0, 10), scratch, target)
const paired = [...mask, ...payload, ...mask]
const latePaired = [...Array.from({ length: 256 }, () => ({ a: 0, b: 0, target: 0, gate_i: 15 })), ...paired]

const cases = [
	['rare product', rare, 72],
	['reversed labels', relabel(rare, wire => 38 - wire), 72],
	['restored writes', [...restoredWrites, ...rare], 72],
	['paired XOR masks', paired, payload.length],
	['late paired XOR masks', latePaired, payload.length],
]
const modes = ['off', 'adaptive', 'upfront']

async function compareBroadWorkers(compareReclaim) {
	config.search.rainbow = false
	config.search.strategyAdaptive = true
	const scenarios = compareReclaim
		? [false, true, true, false, false, true].map(reclaim => ({ mode: 'adaptive', reclaim }))
		: modes.map(mode => ({ mode, reclaim: false }))
	for (const { mode, reclaim } of scenarios) {
		config.synthesis.decisionDiagramTrialOrdering = mode
		config.synthesis.decisionDiagramReclaim = reclaim
		const pool = new WorkerPool(1)
		const start = performance.now()
		const counts = []
		try {
			for (const [name, gates, expected] of cases) {
				const wires = gates.reduce((width, gate) => Math.max(width, gate.a + 1, gate.b + 1, gate.target + 1), 0)
				const result = await pool.run(gates, wires, undefined, undefined, 3000, false, 'broad', 0, 'decision-diagram-product')
				if (mode !== 'off' && result.length !== expected) throw new Error(`${name}: unexpected broad-worker result`)
				counts.push(result.length)
			}
		} finally {
			await pool.close()
		}
		const ms = performance.now() - start
		const rewrites = counts.filter((count, i) => count < cases[i][1].length).length
		console.log(JSON.stringify({
			mode, reclaim, counts, rewrites, workerWallMs: Math.round(ms),
			rewritesPerWorkerSecond: Number((rewrites * 1000 / ms).toFixed(2)),
		}))
	}
}

function compareReclamation() {
	for (const [name, gates, expected] of cases) {
		for (const reclaim of [false, true]) {
			const times = []
			let result
			for (let i = 0; i < 5; i++) {
				const start = performance.now()
				result = synthesizeDecisionDiagramProduct(gates, 64, () => false, 'adaptive', reclaim)
				times.push(performance.now() - start)
				if (result?.gates.length !== expected) throw new Error(`${name}: unexpected replacement length`)
			}
			console.log(JSON.stringify({
				name, reclaim, gates: result.gates.length, peakNodes: result.peakNodes, allocatedNodes: result.allocatedNodes,
				liveNodes: result.liveNodes, reclaimedNodes: result.reclaimedNodes, collections: result.collections,
				retainedMemoEntries: result.retainedMemoEntries, scannedMemoEntries: result.scannedMemoEntries,
				skippedMemoEntries: result.skippedMemoEntries, applyCalls: result.applyCalls,
				medianMs: Math.round(times.sort((a, b) => a - b)[2]),
			}))
		}
	}
}

if (process.argv.includes('--worker')) {
	await compareBroadWorkers(process.argv.includes('--reclaim'))
} else if (process.argv.includes('--reclaim')) {
	compareReclamation()
} else {
	for (const [name, gates, expected] of cases) {
		for (const trialOrdering of ['off', 'adaptive', 'upfront']) {
			const times = []
			let result
			for (let i = 0; i < 3; i++) {
				const start = performance.now()
				result = synthesizeDecisionDiagramProduct(gates, 64, () => false, trialOrdering, false)
				times.push(performance.now() - start)
				if ((trialOrdering !== 'off' || result) && result?.gates.length !== expected) throw new Error(`${name}: unexpected replacement length`)
			}
			console.log(JSON.stringify({
				name, trialOrdering, gates: result?.gates.length ?? null, nodes: result?.diagramNodes ?? null, liveNodes: result?.liveNodes ?? null,
				trials: result?.orderingTrials ?? null, prefixReused: result?.reusedPrefixGates ?? null,
				medianMs: Math.round(times.sort((a, b) => a - b)[1]),
			}))
		}
	}
}
