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
| `generationStreamingComparison` | Baseline, exact candidate cache, bounded staging stream, and both |
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

`database.generationCountFinalInserts` selects insert-time function counting when
`database.generationStates` is nonzero. Unlimited jobs skip final-function counting
entirely; their progress percentage and ETA use committed parent work. Enabling a
state limit on resume reconstructs the exact count once before enforcing the limit.
The counting-comparison benchmark sets a permissive limit to exercise both paths.
Both strategies retain upserts that improve an existing circuit's cost. With
insert-time counting, the final lookup timer includes the trigger's membership
checks; compare total elapsed time instead of expecting the same phase split.
The counter is connection-local, transactional and removed after generation.

Insert-time counting is off by default. The recorded comparison in
[2026-11-17-final-insert-counting.json](results/2026-11-17-final-insert-counting.json)
contains 18 complete builds and 108 query-only trials. Isolated query costs
improved, but whole-build results varied and regressed with two staging writers.
Keep the default unless a comparison on your workload supports changing it.


## Reducing and streaming candidate writes

`database.generationCandidateCacheMegabytes` controls fixed typed-array storage
for an exact, same-depth candidate cache; `0` disables it. It rejects repeated
function/wire-mask keys only when their read cost cannot improve an earlier row.
On the final layer it also rejects a different mask with strictly worse wire/read
cost for the same function; equal-cost masks remain eligible for SQL tie selection.
Intermediate layers retain mask alternatives needed for later expansion. Hash
collisions evict entries, never reject a different key. The cache resets at
depth changes and starts empty on resume; it does not replace saved database state.
The configured budget covers retained typed-array payloads, not other job buffers.

`database.generationStreamStaging` feeds staging through an ordered asynchronous
queue. `generationStagingQueueBatches` bounds admitted batches, including the one
being written. The producer can additionally hold its current batch; worker,
lookahead, shard partial-row and native SQLite buffers remain separate bounds.
The queue drains before results are merged or committed. On handled failure it
settles active writes before rollback and drops queued writes. Existing checkpoint
transactions and durability are unchanged; queued rows are not checkpoints.

Verbose logs show the queue snapshot and the percentage of redundant candidate
rows rejected before SQL. `stage wait` measures producer waits for queue capacity,
drain and staging setup; background writes can overlap candidate preparation.
SQLite caching, commits and WAL checkpoints can still produce physical I/O bursts.
Judge streaming by complete-build time or committed parents/s, not disk smoothness.

Defaults are a 32 MiB candidate-cache budget, streaming enabled, and two admitted
staging batches. [Recorded comparisons](results/2026-11-17-staging-streaming.json)
cover 36 complete builds with matching outputs: cache-only, stream-only, combined
and baseline variants on 3/4 and 4/3 tables. Combined medians were 0.84s versus
1.84s on 3/4, and 6.95s versus 10.03s on 4/3 with one staging writer. At two
staging writers with insert-time counting enabled, 4/3 medians were 6.78s versus
10.17s. Three shared-host samples per variant do not establish production 4/5
throughput. Streaming alone did not consistently help; the combined pipeline did.


## Final-layer SQL reductions

Final expansion with multiple staging writers merges each function-disjoint shard
straight into the main lookup, avoiding a copy into the main temporary candidate
table. Scratch transactions must finish first; output and frontier consumption still
commit together in the main transaction. Scratch files remain disposable on restart.
No database format change or regeneration is required for unfinished current-format
tables. Unlimited checkpoints mark their untracked function count explicitly; this
is distinct from saved work and does not affect resumability.


[Recorded complete-build comparisons](results/2026-11-17-final-generation-work.json)
against main cover three alternating repeats per variant for 3/4 and 4/3 tables,
with two staging writers, two expansion workers and identical unlimited settings.
All 12 builds passed exhaustive replacement checks and matched semantic/cost
digests. Median times were 1.22s versus 1.36s on 3/4 and 6.68s versus 6.95s on
4/3. Every paired trial improved, with substantial timing variation. These small
fixtures measure the combined changes and do not predict production 4/5 speedups.
