// Run after npx tsc: node experiments/profile-factored-checkpoint.mjs file.json [edge-limit]
import fs from 'node:fs';
import { FactoredGraph, analyzeFactored } from '../dist/factored.js';
const path = process.argv[2], limit = Number(process.argv[3] ?? 16000000);
if (!path)
    throw new Error('A checkpoint path is required');
const data = JSON.parse(fs.readFileSync(path));
const gates = data.gates.map(([a, b, target, gate_i]) => ({ a, b, target, gate_i }));
let graph;
const compose = FactoredGraph.prototype.compose;
FactoredGraph.prototype.compose = function (...args) { graph = this; return compose.apply(this, args); };
const start = performance.now();
let result = { path, gates: gates.length, edge_limit: limit };
try {
    const analysis = analyzeFactored(gates, { maximumWires: 64, maximumNodes: 200000, maximumEdges: limit, stopped: () => performance.now() - start > 45000 });
    const rows = analysis.rows;
    const groups = new Map();
    for (const form of graph.forms) {
        const g = groups.get(form.signature) ?? [];
        g.push(form.id);
        groups.set(form.signature, g);
    }
    const duplicates = [...groups.values()].filter(g => g.length > 1);
    result = { ...result, canonical_identity_outputs: rows.filter((r, i) => r === graph.inputs[i]).length, output_atom_counts: rows.map(r => r.atoms.length), duplicate_signature_groups: duplicates.length, duplicate_signature_forms: duplicates.reduce((n, g) => n + g.length, 0), largest_signature_group: Math.max(0, ...duplicates.map(g => g.length)), emitted_gates: graph.emit(rows, gates.length)?.length ?? null };
}
catch (error) {
    result.failure = error.message;
}
result = { ...result, forms: graph?.forms.length, products: graph?.products.length, edges: graph?.edges, elapsed_ms: Math.round(performance.now() - start), rss_mb: Math.round(process.memoryUsage().rss / 1048576) };
console.log(JSON.stringify(result));
