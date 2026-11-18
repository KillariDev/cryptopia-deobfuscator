// Run after npx tsc. No original puzzle or generator proof is used.
import fs from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import assert from 'node:assert/strict';
import { pathToFileURL, fileURLToPath } from 'node:url';
const root = fileURLToPath(new URL('../', import.meta.url)), imp = async (name) => import(pathToFileURL(root + '/dist/' + name + '.js'));
const [{ RainbowPortfolio }, { LimitedMap }, utils, { createDependencyGraph }, { sweepFactored }] = await Promise.all([imp('rainbow-portfolio'), imp('limitedMap'), imp('utils'), imp('lineswapper'), imp('sat-sweeping-core')]);
const { config } = await imp('config');
const { createRainbowTable } = await imp('rainbowtable');
const directory = await mkdtemp(join(tmpdir(), 'abstract-rainbow-probe-'));
config.files.dataDirectory = directory;
config.files.databaseDirectory = directory;
config.logging.verbose = false;
config.logging.generationDiagnostics = false;
const db = await createRainbowTable(3, 3);
const tables = new RainbowPortfolio([{ wires: 3, gates: 3, db }]);
const gate = (a, b, target, gate_i) => ({ a, b, target, gate_i });
const results = {};
try {
    const cn = gate(0, 0, 1, 3), and = gate(0, 1, 2, 1), abstract = [cn, and, cn];
    const hit = (await tables.findReplacements([{ mappedGates: abstract, wires: 3 }], new LimitedMap(100))).get(0);
    assert.ok(hit);
    assert.equal(hit.gates.length, 1);
    for (const input of utils.generateCombinations(3))
        assert.deepEqual(utils.evalCircuit(abstract, input), utils.evalCircuit(hit.gates, input));
    // A and B each stand for an expression of six independent primary inputs.
    for (const input of utils.generateCombinations(12)) {
        const a = input.slice(0, 6).every(Boolean), b = input.slice(6).reduce((x, y) => x !== y, false);
        for (const target of [false, true])
            assert.deepEqual(utils.evalCircuit(abstract, [a, b, target]), utils.evalCircuit(hit.gates, [a, b, target]));
    }
    results.abstract_rainbow = { table: { wires: 3, gates: 3 }, abstract_inputs: 2, accumulator_wires: 1, primary_support: 12, before_abstract_gates: 3, after_abstract_gates: hit.gates.length, exhaustive_substituted_assignments: 8192, limitation: 'A logical cut rewrite, not yet a physical circuit rewrite: leaf values need to be live or reversibly materialized.' };
    const sparse = [cn, ...Array.from({ length: 10000 }, (_, i) => i % 2 ? gate(2, 3, 4, 1) : gate(0, 0, 5, 15)), cn];
    const start = performance.now(), nodes = createDependencyGraph(sparse), map = utils.dependencyGraphToMap(nodes), selected = utils.dependencySort(map, nodes.at(-1), 2, nodes, sparse);
    assert.deepEqual(selected, [0, 10001]);
    const subset = selected.map(i => sparse[i]);
    const mapping = utils.mapVariablesToIndexes(subset);
    const replace = (await tables.findReplacements([{ mappedGates: utils.mapCircuit(subset, mapping), wires: mapping.length }], new LimitedMap(100))).get(0);
    assert.ok(replace);
    assert.equal(replace.gates.length, 0);
    const cut = new Set(selected), candidate = sparse.filter((_, i) => !cut.has(i));
    for (const input of utils.generateCombinations(6))
        assert.deepEqual(utils.evalCircuit(sparse, input), utils.evalCircuit(candidate, input));
    results.dependency_region = { span_gates: sparse.length, selected_gates: selected.length, selected_wires: mapping.length, removed_gates: 2, exhaustive_inputs: 64, elapsed_ms: Math.round(performance.now() - start), finding: 'Existing dependencySort can already find the noncontiguous region globally; broadSearch only supplies contiguous windows and local search is chunk-bounded.' };
    const t = gate(0, 1, 2, 1), cx = gate(3, 0, 4, 3), identity = [t, cx, gate(2, 4, 5, 1), cx, gate(2, 3, 5, 1), gate(2, 4, 5, 1), t];
    const cubic = [gate(6, 7, 8, 1), gate(8, 9, 10, 1), gate(6, 7, 8, 1)];
    const mixed = [];
    let ci = 0;
    for (let i = 0; i < identity.length; i++) {
        mixed.push(identity[i]);
        if (i % 2 === 0 && ci < cubic.length)
            mixed.push(cubic[ci++]);
    }
    const opts = { maximumWires: 64, maximumNodes: 200000, maximumEdges: 16000000, stopped: () => false };
    const globalStats = { queries: 0, merges: 0, counterexamples: 0 };
    const whole = await sweepFactored(mixed, opts, performance.now() + 10000, globalStats);
    assert.ok(whole && whole.length < mixed.length);
    assert.ok(globalStats.merges > 0);
    const regionStats = { queries: 0, merges: 0, counterexamples: 0 };
    const regional = await sweepFactored(identity, opts, performance.now() + 10000, regionStats);
    assert.deepEqual(regional, []);
    for (const input of utils.generateCombinations(11)) {
        assert.deepEqual(utils.evalCircuit(mixed, input), utils.evalCircuit(whole, input));
        assert.deepEqual(utils.evalCircuit(mixed, input), utils.evalCircuit(cubic, input));
    }
    results.sat_mixed_circuit = { before_gates: mixed.length, whole_circuit_output: whole?.length ?? null, whole_circuit_proofs: globalStats, dependency_region_gates: identity.length, dependency_region_output: regional.length, regional_proofs: regionStats, patched_circuit_gates: cubic.length, exhaustive_inputs: 2048, finding: 'The whole-circuit sweep keeps proved write cancellations even with a live cubic output. The isolated dependency region can remove the entire independent identity.' };
}
finally {
    await tables.close();
    await rm(directory, { recursive: true, force: true });
}
if (process.argv[2])
    fs.writeFileSync(process.argv[2], JSON.stringify(results, null, 2) + '\n');
console.log(JSON.stringify(results, null, 2));
