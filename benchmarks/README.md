# Benchmark guide

Run commands from the repository root. Settings come from `solver.config.json`
or the file selected by `OPTIMIZER_CONFIG`. Reports are written under
`files.dataDirectory`; benchmark filenames and limits are in the `benchmark`
section. The versioned `results/` summaries retain previous measurements.

## Solver comparisons

```bash
npm run benchmark -- data/latest.json data/obfuscated.json
npm run benchmark:ablate -- data/latest.json data/obfuscated.json
npm run benchmark:cases
npm run test:benchmark
```

`benchmark` compares the reference and tuned solver on the supplied circuit.
`benchmark:ablate` compares individual features; `benchmark:cases` runs the
versioned circuits in [cases.json](cases.json). `test:benchmark` runs a short
case-suite smoke test. Control `seconds`, `repeats`, `seed`, `workerCounts`,
`variants` and output locations in the benchmark settings. A short search budget
can be noisy; inspect per-trial reductions and overruns, not only averages.

## Complete lookup-table builds

```bash
npm run benchmark:generation
npm run benchmark:generation -- --smoke
npm run benchmark:generation -- --reference /path/to/compiled/reference
```

Each trial uses a fresh database and process. Timing includes setup, scratch
imports/disposal and final cleanup/compaction. Every generated replacement is
exhaustively checked; coverage/cost digests must match across variants. Reports
include process CPU time, sampled database sizes, effective settings and runtime
fingerprints. Newer builds also report phase and named SQL-operation timings.

Choose tables, CPU workers and repetitions with `generationTables`, `workerCounts`
and `repeats`. The reference checkout must already have dependencies installed
and TypeScript compiled. Its own settings file supplies its settings.

Enable at most one generation comparison mode:

| Setting | Comparison |
| --- | --- |
| `generationFinalComparison` | Candidate counting versus output-insert counting |
| `generationWriterComparison` | Compact bindings, statement/batch sizes and 1/2/4 staging writers |
| `generationPrefetchComparison` | Serialized expansion, lookahead, and lookahead with diagnostics |
| `generationStagingComparison` | Indexed versus append staging |

To isolate a change, keep the other settings fixed. Per-operation times exclude
final compaction; whole-build elapsed time includes it. Parallel staging does
not make main lookup writes or checkpoint commits concurrent.

## Database operations

```bash
npm run benchmark:staging
npm run benchmark:merge
npm run benchmark:dedup
npm run benchmark:final-lookup
```

These focused fixtures compare candidate insertion, lookup merging, membership
queries and the final selection/count/write pipeline. Add `-- --smoke` for short
runs. `stagingRows`, `dedupSeenRows`, `dedupCandidateFunctions`,
`dedupMasksPerFunction` and `repeats` control fixture sizes.

The final-lookup fixture covers different proportions of shorter-depth functions,
new/improving candidates and equal-cost hits. It records query plans and compares
function counts and output payloads. It is an index/metadata fixture; complete
build tests provide circuit-semantic validation. Query-only timings exclude
setup, validation and transaction commit. They do not predict whole-job speedups.

Shared-host, warm-cache fixtures are not production disk benchmarks. Keep the
workload, worker count, cache settings and validation controls with the results,
and verify full-job behavior before changing defaults.

`database.generationCountFinalInserts` selects insert-time function counting.
Both strategies retain upserts that improve an existing circuit's cost. With
insert-time counting, the final lookup timer includes the trigger's membership
checks; compare total elapsed time instead of expecting the same phase split.
The counter is connection-local, transactional and removed after generation.

Insert-time counting is off by default. The recorded comparison in
[2026-11-17-final-insert-counting.json](results/2026-11-17-final-insert-counting.json)
contains 18 complete builds and 108 query-only trials. Isolated query costs
improved, but whole-build results varied and regressed with two staging writers.
Keep the default unless a comparison on your workload supports changing it.
