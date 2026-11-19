// Run after npx tsc. Pass an output directory to save both circuits.
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { cancelBlocks } from '../dist/block-cancellation.js'
import { synthesizeFactored } from '../dist/factored.js'
import { simplifyMixedBasis } from '../dist/mixed-basis.js'
import { synthesizePolynomialShear } from '../dist/polynomial-shear.js'
import { sweepFactored } from '../dist/sat-sweeping-core.js'
import { createPolynomialEquivalenceChecker, synthesizePolynomial } from '../dist/symbolic-affine.js'
import { emitBorrowedProduct, synthesizeDecisionDiagramProduct } from '../dist/decision-diagram-product.js'

const wireCount = 39
const target = 38
const inputs = Array.from({ length: wireCount }, (_, i) => i)
const controls = inputs.slice(0, 20)
const scratch = inputs.slice(20, target)

let seed = 73
function shuffled(values) {
	const result = values.slice()
	for (let i = result.length - 1; i > 0; i--) {
		seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0
		const j = Math.floor(seed / 2 ** 32 * (i + 1))
		;[result[i], result[j]] = [result[j], result[i]]
	}
	return result
}

const puzzle = Array.from({ length: 33 }, () =>
	emitBorrowedProduct(shuffled(controls), shuffled(scratch), target)).flat()

async function measure(name, run) {
	const start = performance.now()
	const result = await run(() => performance.now() - start >= 5000, start + 5000)
	console.log(JSON.stringify({ name, gates: result?.length ?? null, ms: Math.round(performance.now() - start) }))
	return result
}

console.log(JSON.stringify({ wireCount, inputGates: puzzle.length }))
const limits = { maximumWires: 64, maximumNodes: 200000, maximumEdges: 16000000 }
await measure('polynomial shear', stopped =>
	synthesizePolynomialShear(puzzle, 64, 100000, 10000000, stopped, 202))
await measure('ANF synthesis', (stopped, deadline) =>
	synthesizePolynomial(puzzle, 64, 100000, 10000000, deadline, stopped))
await measure('factored synthesis', stopped => synthesizeFactored(puzzle, { ...limits, stopped }))
await measure('block cancellation', stopped => cancelBlocks(puzzle, { ...limits, stopped }))
await measure('mixed basis', stopped => simplifyMixedBasis(puzzle, { ...limits, stopped }))
const stats = { queries: 0, merges: 0, counterexamples: 0 }
await measure('SAT sweeping', (stopped, deadline) => sweepFactored(puzzle, { ...limits, stopped }, deadline, stats))
console.log(JSON.stringify({ satStats: stats }))

const solved = await measure('decision diagram', stopped => {
	const result = synthesizeDecisionDiagramProduct(puzzle, 64, stopped)
	if (!result) throw new Error('Decision diagram did not recover the product')
	const { gates, ...details } = result
	console.log(JSON.stringify({ exact: true, ...details }))
	return gates
})

const equivalent = createPolynomialEquivalenceChecker(puzzle, wireCount, 100000, 10000000)
const proofStart = performance.now()
const polynomialProof = equivalent(solved)
const identityProof = equivalent([])
if (polynomialProof !== true || identityProof !== false) throw new Error('Independent polynomial check disagreed')
console.log(JSON.stringify({ polynomialProof: polynomialProof ?? null, identityProof: identityProof ?? null, ms: Math.round(performance.now() - proofStart) }))

if (process.argv[2]) {
	const directory = process.argv[2]
	mkdirSync(directory, { recursive: true })
	for (const [file, gates] of [['rare-product.json', puzzle], ['rare-product-solved.json', solved]]) {
		const tuples = gates.map(({ a, b, target, gate_i }) => JSON.stringify([a, b, target, gate_i]))
		writeFileSync(join(directory, file), `{"wire_count":${wireCount},"gate_count":${gates.length},"gates":[\n${tuples.join(',\n')}\n]}\n`)
	}
}
