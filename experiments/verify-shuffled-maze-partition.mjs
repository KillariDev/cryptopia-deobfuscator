// Run after npx tsc: node experiments/verify-shuffled-maze-partition.mjs
import { readFileSync } from 'node:fs'
import { createPolynomialEquivalenceChecker } from '../dist/symbolic-affine.js'

const fixture = new URL('../data/nonlinear-basis-maze-shuffled.json', import.meta.url)
const { gates, wire_count: wires } = JSON.parse(readFileSync(fixture, 'utf8'))
const start = 21881
const end = 21907
const original = gates.slice(start, end)

// The same product of wires 0 and 31 updates both wires 5 and 42.
// This lets the two temporary 42-to-5 XORs and the write to 5 cancel.
// The three writes to 32 collapse to the change in 37 plus that product.
const removed = new Set([21881, 21884, 21892, 21894, 21906])
const candidate = original.flatMap((gate, offset) => {
    const index = start + offset
    if (index === 21899) return [[49, 50, 32, 6], [0, 31, 32, 1]]
    return removed.has(index) ? [] : [gate]
})
const toGate = ([a, b, target, gate_i]) => ({ a, b, target, gate_i })
const equivalent = createPolynomialEquivalenceChecker(original.map(toGate), wires, 100000, 10000000)
if (equivalent(candidate.map(toGate)) !== true) {
    throw new Error('Failed to prove the window replacement')
}
console.log(JSON.stringify({
    window: [start, end],
    input_gates: original.length,
    replacement_gates: candidate.length,
    full_circuit_gates_after_splice: gates.length - original.length + candidate.length,
    exact_equivalence: true,
}))
