// Experimental 3-leaf cut scan, with an explicitly raised 64M-edge allowance.
// Run after npx tsc: node --max-old-space-size=4096 experiments/profile-checkpoint-cuts.mjs file.json
import fs from 'node:fs';
import { analyzeFactored } from '../dist/factored.js';
const path = process.argv[2];
if (!path)
    throw new Error('Usage: node experiments/profile-checkpoint-cuts.mjs checkpoint.json');
const gates = JSON.parse(fs.readFileSync(path)).gates.map(([a, b, target, gate_i]) => ({ a, b, target, gate_i }));
const start = performance.now();
const { graph, rows } = analyzeFactored(gates, { maximumWires: 64, maximumNodes: 200000, maximumEdges: 64000000, stopped: () => performance.now() - start > 45000 });
const groups = new Map();
for (const f of graph.forms) {
    const a = groups.get(f.signature) ?? [];
    a.push(f);
    groups.set(f.signature, a);
}
const candidates = [];
for (const group of groups.values())
    for (let j = 1; j < group.length; j++) {
        const a = group[0], b = group[j], diff = [];
        let i = 0, k = 0;
        while (i < a.atoms.length || k < b.atoms.length) {
            if (k === b.atoms.length || (i < a.atoms.length && a.atoms[i] < b.atoms[k]))
                diff.push(a.atoms[i++]);
            else if (i === a.atoms.length || b.atoms[k] < a.atoms[i])
                diff.push(b.atoms[k++]);
            else {
                i++;
                k++;
            }
        }
        candidates.push({ a: a.id, b: b.id, diff });
    }
const hist = {};
for (const c of candidates) {
    const size = c.diff.length, key = size <= 1 ? '0-1' : size <= 2 ? '2' : size <= 4 ? '3-4' : size <= 8 ? '5-8' : size <= 16 ? '9-16' : size <= 32 ? '17-32' : '>32';
    hist[key] = (hist[key] ?? 0) + 1;
}
// Shared AND factors expose a small abstract boundary even when their forms
// depend on many primary input wires. Enumerate cuts over a small XOR miter.
const singleton = new Map(graph.forms.filter(f => f.atoms.length === 1).map(f => [f.atoms[0], f]));
const memo = new Map();
const maxLeaves = 3, maxCuts = 12;
function cuts(form) {
    if (memo.has(form.id))
        return memo.get(form.id);
    let found = [[form.id]];
    memo.set(form.id, found);
    let children = [];
    if (!form.atoms.length)
        return [[]];
    if (form.atoms.length === 1) {
        const atom = form.atoms[0];
        if (atom === 0)
            return [[]];
        if (atom <= graph.wires.length)
            return found;
        const p = graph.products[atom - graph.wires.length - 1];
        children = [p.left, p.right];
    }
    else {
        if (form.atoms.length > 8)
            return found;
        children = form.atoms.filter(a => a !== 0).map(a => singleton.get(a));
    }
    let front = [[]];
    for (const child of children) {
        const next = new Map();
        for (const left of front)
            for (const right of cuts(child)) {
                const union = [...new Set([...left, ...right])].sort((a, b) => a - b);
                if (union.length <= maxLeaves)
                    next.set(union.join(','), union);
            }
        front = [...next.values()].slice(0, maxCuts);
        if (!front.length)
            break;
    }
    for (const c of front) {
        if (c.length === 1 && c[0] === form.id)
            continue;
        found.push(c);
    }
    found = found.slice(0, maxCuts);
    memo.set(form.id, found);
    return found;
}
function value(form, assignment, cache) { if (assignment.has(form.id))
    return assignment.get(form.id); if (cache.has(form.id))
    return cache.get(form.id); let v = false; for (const atom of form.atoms) {
    let x;
    if (atom === 0)
        x = true;
    else if (atom <= graph.wires.length)
        throw new Error('uncovered input');
    else {
        const p = graph.products[atom - graph.wires.length - 1];
        x = value(p.left, assignment, cache) && value(p.right, assignment, cache);
    }
    v = v !== x;
} cache.set(form.id, v); return v; }
let checked = 0, proved = 0, sharedAbstractProofs = 0;
const examples = [];
for (const c of candidates.filter(c => c.diff.length <= 4).slice(0, 4096)) {
    const roots = c.diff.filter(a => a !== 0).map(a => singleton.get(a));
    let frontier = [[]];
    for (const root of roots) {
        const next = new Map();
        for (const left of frontier)
            for (const right of cuts(root)) {
                const union = [...new Set([...left, ...right])].sort((a, b) => a - b);
                if (union.length <= maxLeaves)
                    next.set(union.join(','), union);
            }
        frontier = [...next.values()].slice(0, maxCuts);
        if (!frontier.length)
            break;
    }
    checked++;
    for (const cut of frontier) {
        let zero = true;
        for (let bits = 0; bits < (1 << cut.length); bits++) {
            const assignment = new Map(cut.map((id, i) => [id, !!(bits & (1 << i))]));
            let parity = c.diff.includes(0);
            try {
                for (const root of roots)
                    parity = parity !== value(root, assignment, new Map());
            }
            catch {
                zero = false;
                break;
            }
            if (parity) {
                zero = false;
                break;
            }
        }
        if (zero) {
            proved++;
            if (cut.some(id => graph.forms[id].support.toString(2).replaceAll('0', '').length > 3))
                sharedAbstractProofs++;
            if (examples.length < 5)
                examples.push({ forms: [c.a, c.b], delta_atoms: c.diff.length, cut_size: cut.length, leaf_primary_support: cut.map(id => graph.forms[id].support.toString(2).replaceAll('0', '').length) });
            break;
        }
    }
}
const result = { checkpoint: path, gates: gates.length, forms: graph.forms.length, ands: graph.products.length, edges: graph.edges, simulation_candidate_pairs: candidates.length, delta_size_histogram: hist, scan_parameters: { maximum_leaves: maxLeaves, maximum_cuts_per_form: maxCuts, maximum_expanded_xor_fanins: 8, maximum_candidate_pairs: 4096 }, small_delta_candidates_checked: checked, universal_small_cut_proofs: proved, proofs_with_large_support_abstract_leaves: sharedAbstractProofs, examples, elapsed_ms: Math.round(performance.now() - start) };
console.log(JSON.stringify(result));
