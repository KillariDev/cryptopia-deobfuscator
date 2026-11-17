# Obfustopia Deobfuscator

This deobfuscator is designed to break the obfuscation implemented in [gausslabs/obfustopia](https://github.com/gausslabs/obfustopia).

Learn more about the challenge and its resolution from the article:  
[Breaking the $10,000 iO Bounty: My Journey to Crack an Indistinguishability Obfuscation Implementation](https://mirror.xyz/killaridev.eth/x2x6yFhovUQJxICCM8jJ7ezcjIvqyRN1iQfsWCG_Doc)

## Installation

Install dependencies:

```bash
npm ci
```

## Usage

Run the deobfuscator with the following command:

```bash
npm run optimize data/latest.json data/obfuscated.json
```

This will read circuit `data/latest.json` in. If the file does not exist, it copies the `data\obfuscated.json` to its place and starts to operate.

At startup, the tool prints the task, original and resume inputs, gate and wire counts, output locations, worker limit, round budget, rainbow-table settings, and validation settings before initializing the database.

Every 30 seconds, if worker snapshots contain fewer gates than the last saved circuit, the coordinator verifies the combined circuit and saves it. After five minutes, rounds with gate reductions ask all workers to finish between optimization steps; rounds without reductions retain the 25-minute budget.

The process saves progress checkpoints to `data/progress/<name>.solved-<gate-count>.json` and the most recent completed circuit to `data/latest.json`. Worker snapshots are stored in `data/worker/<name>_worker<index>.json`, updated before and after each worker job. Output folders are created automatically. You can exit from the program and run the command again to restart. The optimizer runs forever, so you need to exit from program with "ctrl c".
## Worker configuration

Use Node.js 22 or newer. The optimizer keeps a pool of workers alive across
rounds, retaining their bounded lookup caches and SQLite connections. Circuit
chunks are exchanged through worker messages; the files in `data/worker/` are
snapshots for inspection, not the worker communication mechanism. Completed
rounds also save verified checkpoints.

By default, the pool uses up to 24 workers, capped by Node's available CPU count.
Each worker has its own caches, so reduce concurrency if memory or database I/O
is the bottleneck. Override the limit with a positive integer:

```powershell
$env:OPTIMIZER_WORKERS = "4"
npm run optimize -- data/latest.json data/obfuscated.json
```

On bash, use `OPTIMIZER_WORKERS=4 npm run optimize -- data/latest.json data/obfuscated.json`.

Run `npm test` for reference checks covering packed circuit evaluation, dependency
graphs, shuffle equivalence, SQLite lookup caching, and worker reuse/failure handling.
Verification of large circuits still uses random inputs; these improvements do
not make checkpoint verification a formal equivalence proof or repair an
already-invalid checkpoint.

## Progress logging

The default output summarizes each round every 30 seconds: completed worker
chunks, candidate gate count, gates removed, removal rate, and elapsed time.
Workers report search passes, subsets visited, optimization checks, improving
rewrites, and their current stage. Each summary includes aggregate activity,
time-budget usage, and the age of the oldest active report. Time-budget usage
is not a percentage of the search space explored. Reduced circuit snapshots
are sent from completed optimization steps; counts remain provisional until
the coordinator verifies and saves the combined checkpoint.
Startup details, checkpoint saves, and errors remain visible. Individual
replacement, shuffle timeout, and database insertion details are suppressed.

For detailed diagnostics, enable verbose logging before starting:

```powershell
$env:OPTIMIZER_VERBOSE = "1"
npm run optimize -- data/latest.json data/obfuscated.json
```

On bash, use `OPTIMIZER_VERBOSE=1 npm run optimize -- data/latest.json data/obfuscated.json`.

## Candidate evaluation

The solver stops gate-pair searches at the first applicable match and builds
adjacency lists without copying existing entries. Candidate windows share their
wire mappings between optimization passes when the circuit has not changed.
Probabilistic checks keep the same 202 inputs: the first input is tested
individually for quick rejection, and the remaining inputs use packed batches.
Subset selection uses per-wire access indexes shared for the current graph.
Completed checkpoints are verified and serialized once, then the same payload
is written to both the progress file and `data/latest.json`. Randomized verification guarantees are unchanged.

## JSON settings

Edit `solver.config.json` in the repository root, then restart the solver.
Provide the working and original circuit filenames for each job:

```bash
npm run optimize -- data/latest.json data/obfuscated.json
```

These job-specific inputs are command-line arguments, not JSON settings.
Startup prints the configuration file and effective settings. Changes apply
on the next run, not during a run.

- `files`: output root, latest filename, worker/progress subdirectories, and rainbow database directory. Relative paths use the current working directory.
- `runtime.heapMegabytes`: Node heap limit used by `optimize` and `optimize-prof`.
- `workers`: CPU-based concurrency cap, minimum chunk size, and maximum chunk fraction.
- `timing`: round budget and improved-round target in minutes; summary/checkpoint, worker-report, database-log and standalone-save intervals in seconds. The summary interval also controls checking the improved-round target.
- `logging.verbose`: enable detailed diagnostics.
- `validation`: checkpoint test inputs, probabilistic test inputs, and maximum supported circuit wires. Fewer inputs reduce verification confidence.
- `search`: probabilistic/variable elimination switches, maximum wires for exhaustive checks, inclusive subset/slice ranges, internal chunk sizing, and shuffle passes.
- `cache`: per-worker lookup/processed cache capacities and shuffle cache capacity.
- `database`: rainbow table portfolio, query/insert batch sizes, disk generation bounds, and ETA smoothing settings. Changing wire/gate limits selects a different database and may require building it.

Settings omitted from a section use the defaults. Unknown keys, invalid types,
and unsupported ranges fail at startup. The checked-in file lists all options.
Algorithm constants such as 32-bit packing and gate truth tables remain fixed.

`OPTIMIZER_CONFIG` selects another JSON file. `OPTIMIZER_WORKERS` overrides the
worker cap with an exact worker limit, and `OPTIMIZER_VERBOSE=1`/`0` overrides
verbose logging. These environment variables remain optional. Workers receive
the coordinator's parsed configuration, so all workers use the same settings.

## Adaptive search and incremental evaluation

The `search` settings also control the following optimizations:

- `adaptive`, `explorationEvery`, `searchArms`: learn gates removed per millisecond for subset/slice sizes and variable/rainbow/combined methods. Every Nth choice explores another option. Statistics remain in each persistent worker; method-specific failure caches are separate.
- `prioritizeChangedWires`: search changed wires and their dependencies first after a rewrite. Fully searched, unchanged subsets are remembered in a bounded cache; changed subsets get new keys. Other regions remain eligible for search. `cache.subsetEntries` limits remembered subsets; each method-specific failure cache uses `cache.processedEntries`.
- `incrementalEvaluation`, `prefixCacheBytes`, `prefixStride`: retain bounded packed states along a reference circuit and resume candidate evaluation at a checkpoint before its first changed gate. The byte budget covers retained prefix states per reference evaluator; reference/input buffers are additional. A candidate's unchanged suffix is still evaluated.
- `normalizedCacheEntries`: bounded exact-rewrite cache shared across first-use wire renamings. Gate order, control orientation and wire aliases are preserved. Only exhaustively checked rewrites are shared this way; probabilistic results are not transferred between wire permutations.
- `balancedWorkers`: keep chunks contiguous but choose boundaries using wire count, adjacent dependencies and previous execution time per gate for each wire. Dense/expensive regions receive fewer gates per chunk. History is an estimate and does not guarantee equal finishing times.

Probabilistic checks retain their scalar first-input rejection and existing test
inputs. Remaining outputs are compared directly as packed words; Boolean output
conversion is only needed when populating the reference cache. Candidate edits
that cannot improve the existing gate-count/wire-count/read-count ordering are
rejected before equivalence evaluation. These heuristics change search order;
full-scale gains depend on the circuit and database workload.

### Compact status

Normal updates show the remaining gate count, percentage fewer gates than the
original, gates removed this round, checkpoint state, active workers and elapsed
time toward the current round target. Gate reduction is not solver completion.
Improved rounds use the five-minute target by default; otherwise the default is
25 minutes. Finished rounds say “All workers finished” rather than showing a
partial time-budget percentage. Routine report age and internal search counters
are shown only in verbose mode. Delayed worker updates produce a warning.

## Rainbow table generation

There is one table format and one generator. Tables are named
`rainbow_<wires>_<gates>.db` under `files.databaseDirectory`. The solver initializes
every configured table sequentially before starting optimization. Missing tables
are generated; completed tables are used as-is.
Interrupted builds made by this generator resume automatically. The packed/direct
format uses a new build signature and cost columns. Earlier completed tables and
unfinished builds are rejected without migration: keep their files and finish
them with their original version, or choose a fresh `files.databaseDirectory`.
Installing this version cannot resume an earlier unpacked build.
There is no migration, rebuild command,
format selector, or compatibility mode for older hash tables.

The table uses exact packed truth-table BLOB keys, binary gate payloads and
`WITHOUT ROWID`. For four wires a key holds the complete mapping. Generation
and lookup use the same fixed wire labels, with input wires numbered in numeric
order. All functions reachable within the configured gate catalog/depth remain
eligible; generation does not discard functions based on a sequence's first-use
wire order. Lookup does not borrow wires absent from the candidate window.

Generation expands truth tables incrementally, breadth-first by function.
Equal-depth alternatives retain used-wire/read-cost metadata needed to choose
shorter continuations correctly. Frontiers, visited functions and committed
progress live in SQLite. Each bounded batch writes its results and advances
its frontier in the same transaction, so a failed/interrupted batch can be retried.
Database inserts use multi-row statements, not a JavaScript await for every row.
Build keys use the packed lookup representation (8 bytes for four wires, rather
than 16 unpacked bytes). Expansion workers retain unpacked states for fast gate
transitions, with exact open-addressed deduplication over typed buffers instead
of allocating a hexadecimal string/object for each candidate. Hash matches are
checked against all state bytes and the used-wire mask.

The last expansion layer merges candidates directly into the lookup table;
there is no final-depth visited/frontier write followed by a separate drain.
A SQL merge ranks candidates by gate count, distinct used wires, then read count,
matching the solver's replacement ordering. Those three integer cost columns
are used only during generation to compare candidates without fetching and decoding
existing gate payloads in JavaScript. Final cleanup removes them.

Generation settings (the obsolete `insertBatchSize` and `keepGenerationState` settings have been removed):

- `database.queryBatchSize`: lookup SQL parameter budget (at most 900). Generation staging has its own budget.
- `database.generationSqlParameters: 8192`: requested bind-variable budget for staging statements, capped at SQLite's compiled variable ceiling (portable 999 ceiling if compile diagnostics omit it). Five columns per candidate means at most 1,638 rows per statement at the default. This does not change lookup query limits or transaction/checkpoint size.
- `database.generationPreparedInserts: true`: reuse prepared staging inserts across flushes, with serialized bindings on the generation connection. Set `false` for a diagnostic comparison using ordinary SQL calls.
- `database.generationStatementCacheEntries: 8`: bound the LRU by statement row-count shape, including varying tail batches. Statements are finalized on success, pause and failure, before output cleanup/compaction.
- `database.generationSortStaging: false`: optional stable sorting by packed key/mask within each staging buffer. Equal-key tie order remains intact. Sorting is off because it did not improve the larger benchmark fixture consistently.
- `database.generationReadRows: 4096`: maximum frontier rows consumed per transaction. Larger values amortize commits but increase staging space and work repeated after interruption.
- `database.generationCacheMegabytes: 256`: suggested page-cache budget for each of the main and temporary databases (up to approximately twice this value, plus other allocations). This is separate from mmap. SQLite treats it as a cache suggestion, not a hard process memory limit.
- `database.generationTempStore: "file"`: allow candidate staging to spill to disk. `"memory"` is opt-in and can consume substantial additional RAM; the page-cache setting does not bound an in-memory temporary database.
- `database.generationJournalMode: "wal"`: build journal mode; `"delete"` is also supported.
- `database.generationSynchronous: "full"`: conservative commit durability. `"normal"` is configurable; in WAL mode it can lose recent committed transactions on power loss, while application interruption remains resumable. No unsafe `OFF` setting is provided.
- `database.generationBatchRows`: maximum raw candidate expansions per CPU task and maximum rows staged in JavaScript before a bulk SQL write. The gate catalog is split too if it exceeds this limit.
- `database.generationStates`: optional distinct-function limit; `0` means unlimited disk-backed generation. Hitting a limit rolls back the current batch; increase the limit or set it to `0`, then restart to resume.
- `database.memoryMapBytes`: mmap setting per connection; `0` disables mapping. SQLite can cap or disable mmap depending on its build.

Only build one copy of a particular table at a time. Disk requirements can still
be substantial; bounded RAM does not make the search space small. Completed
layers and partially processed layers are resumable without recomputing their
committed work. A smaller `gates` limit in a table entry builds a smaller library; enable
bounded on-demand synthesis for uncommon windows instead of precomputing every
larger replacement. Changing wire/gate limits selects a different table filename.

### Parallel generation and profiling

The generator uses precomputed gate-transition arrays and packed transferable
buffers. CPU tasks deduplicate equal `(state, used-wire mask)` candidates locally,
retaining the cheapest read cost and parent/gate references. Full gate sequences
are assembled by the writer only for local survivors. Function keys are packed
directly from states without constructing intermediate boolean arrays.

A persistent CPU pool expands chunks while one SQLite writer stages results.
Results are consumed in submission order. SQLite deduplicates the complete read
batch before updating the global visited set and frontier, rather than updating
both for each small staging flush. The result rows, frontier changes and resume
position still commit in one transaction. Worker errors, write failures, and
state-limit errors roll back the active batch; earlier commits remain resumable.
The packed/direct build format requires fresh tables; existing files are never converted or deleted.

Settings under `database`:

- `generationWorkers: 8`: maximum CPU slots, capped at available CPUs minus one (minimum one). A value of `1` runs the same optimized expansion in the writer process without worker threads. Threads start lazily and persist for the table build.
- `generationQueueBatches: 2`: maximum outstanding tasks per CPU slot, including running tasks and completed results awaiting consumption. Together with `generationBatchRows`, this bounds pending expansion buffering; the writer can additionally retain one yielded expansion result and one staging buffer and the current `generationReadRows` frontier rows.
- `generationMinimumWork: 100000`: batches below this many raw candidate expansions run inline. This avoids worker startup and message overhead for small tables and small layers. Lower it to exercise parallel expansion on smaller batches.

A task contains at most `generationBatchRows` raw expansions. SQLite's temporary
candidate table defaults to `temp_store=FILE` so staging can spill to disk (subject
to the SQLite build). It can hold up to `generationReadRows × gate catalog size` distinct
candidates for a committed read batch; increasing frontier batch size can increase
temporary database space and time between checkpoints. State-limit enforcement
occurs after staging this batch, before commit. Different table files are not
built concurrently.

With verbose logging enabled, periodic diagnostics separate staging, deduplication,
lookup writing, reads and commit time, and name the active phase.
Generation completion also reports expanded/emitted
candidate counts, aggregate expansion worker-seconds, database work time, writer
wait for expansion, thread count, and peak pending tasks. Timings can overlap;
worker-seconds are not job wall time. These measurements help identify whether
CPU expansion or database work limits a build. Extra CPU workers cannot eliminate
a database bottleneck, and the defaults are conservative rather than a promise
of linear speedup. Full 4-wire/5-gate build throughput has not been benchmarked.

### Staging benchmarks

```sh
npm run benchmark:staging
npm run benchmark:staging -- --smoke
```

The staging-only fixture uses four-variable/five-gate candidates produced by the
expansion kernel. `benchmark.stagingRows` defaults to 200,000; `benchmark.repeats`
controls repetitions, and `stagingOutputName` selects the JSON report under the
data directory. Seven variants compare ordinary portable inserts, prepared
portable inserts, ordinary/prepared larger batches, sorted prepared larger
batches, and unsorted/sorted prepared wider batches. The portable budget comes
from `database.queryBatchSize`, the larger budget from `generationSqlParameters`,
and the wider budget from `benchmark.stagingWideSqlParameters` (16,384 by default).
All respect the compiled SQLite ceiling. Smoke mode uses 2,000 rows and one
repetition. It is included in `npm test` without a timing threshold.

Trials rotate/reverse variant order, use fresh temporary tables and verify an
identical complete staged-row digest, including cost/tie winners. Sorting and
initial statement preparation are timed; setup, fixture generation, commit,
validation and statement finalization are excluded. Reports include settings,
per-trial samples, effective parameter limits and prepared-statement/cache counts.
The writer/SQL-helper fingerprint identifies the measured compiled implementation.
These same-process, shared-host trials do not establish cold-disk or full 4/5
production throughput. A new statement budget changes SQL call grouping only;
existing checkpoints can resume without regeneration.

`benchmarks/results/2026-11-17-staging.json` records 36 staging-only trials and
12 complete table builds. On the 500,000-candidate fixture, median staging time
changed from about 3.57s with ordinary 900-parameter inserts to 2.75s with prepared
8,192-parameter inserts. Sorting and the wider 16,384 budget did not improve the
larger fixture consistently, so defaults retain unsorted prepared 8,192 batches.
The smaller fixture was noisier and did not show prepared inserts winning every
comparison; these are descriptive measurements on a shared host.

Complete 3/4 and 4/3 builds used one expansion worker and three fresh processes
per variant. Median creation time changed from about 2.50s to 2.28s and 15.79s to
13.67s respectively, with identical complete coverage/cost digests. These timings
include automatic cleanup and compaction, but exclude post-build validation.
The 4/3 build has 832,167 functions; full production 4/5 gains remain unmeasured.

### Deduplication query scaling

Frontier updates explicitly drive the join from the bounded candidate batch and
probe `BuildSeen` by its primary key. An ordinary join allowed SQLite to choose
a complete scan of the growing visited table for each batch. `CROSS JOIN` fixes
the loop order without adding an index or changing persisted tables. Final-layer
function counts group equal states before probing visited/output tables, so
used-wire-mask variants share the same existence check. All checks remain exact;
frontier masks and lowest-read-cost alternatives are preserved.

```sh
npm run benchmark:dedup
npm run benchmark:dedup -- --smoke
```

This query-only benchmark holds the candidate batch constant while growing the
visited table. JSON settings under `benchmark` control `dedupSeenRows` (default
10,000/100,000/1,000,000), `dedupCandidateFunctions` (2,000),
`dedupMasksPerFunction` (4), `repeats` and `dedupOutputName`. Reports include query
plans, per-trial durations and exact result digests for old/new SQL. Setup and
validation are outside query timings; alternating query order shares the page
cache. These fixtures do not measure cold-disk or full production throughput.
Query-plan regression tests check the actual frontier insertion as well as its
selection, before/after `ANALYZE`, to prevent a future global-scan regression.
No regeneration or checkpoint-format change is required for this optimization.

`benchmarks/results/2026-11-17-dedup.json` records the query-scaling measurements
and twelve complete reference/current builds. With 8,000 candidate rows and one
million visited states, the frontier query median changed from about 109ms to
14ms; the final count changed from about 4.2ms to 2.3ms. Complete 3/4 and 4/3
builds had nearly unchanged overall duration and identical coverage/cost digests.
The improvement targets repeated global scans when visited tables become much
larger; full 4/5 production throughput has not been measured.

### CPU utilization during generation

`database.generationWorkers` defaults to eight expansion slots, capped at available
CPUs minus one. More slots can help CPU-limited expansion; they do not parallelize
SQLite staging, global deduplication, lookup writes or commits. Batches below
`generationMinimumWork` intentionally run inline. The queue refills before yielding
a result to the writer so new expansion work can overlap staging that result;
pending tasks remain bounded by workers × `generationQueueBatches`, plus the
result currently owned by the writer.

To diagnose low utilization, enable `logging.verbose` and inspect phase timings.
High writer wait for expansion suggests expansion is limiting throughput. Dominant
staging/deduplication/lookup times suggest the single writer; these elapsed timings
combine SQL computation and I/O, so disk active time/latency and per-core CPU usage
are needed to distinguish them. Low aggregate CPU alone does not establish a disk
bottleneck. The default cap is eight; compare smaller values when writer time dominates, and
keep the setting that improves completed input-row throughput. Existing small/mid-size
benchmarks did not establish a consistent advantage for four workers over one.

### Multiple tables

`database.tables` replaces the single `database.wires` / `database.gates` settings:

```json
"tables": [
  { "wires": 3, "gates": 6 },
  { "wires": 4, "gates": 5 },
  { "wires": 5, "gates": 2 }
]
```

The defaults retain the existing four-wire/five-gate library, add deeper
three-wire coverage, and add shallow five-wire coverage without making a large
five-wire build the default. These are starting defaults, not benchmarked optimal
sizes. For more five-wire coverage, change its `gates` limit to `3`; generation
and disk costs can grow substantially. To use only the existing table, keep just
`{ "wires": 4, "gates": 5 }`. Remove entries to disable them. The list must be
nonempty, entries must be unique wire/depth pairs, and wire counts must be 1–8.

Lookup tries tables by ascending wire count, then ascending gate limit, regardless
of configuration order. A window skips tables narrower than its used wires.
A miss, a non-improving hit, or a hit requiring an absent wire falls through to
the next fitting table. The first improving replacement wins; this minimizes
lookup work but does not compare every table for the globally shortest result.
Each table uses its own truth-table width and cache namespace. Failed windows
are remembered only after all fitting tables have been tried.

Workers retain one connection per table. `cache.lookupEntries` remains a shared
entry limit across their table lookups; `database.memoryMapBytes` applies per
connection, so adding tables increases possible mapping usage. Different table files are built sequentially to bound resource contention;
candidate expansion within a large table can use multiple CPU workers. Search
lookups use all configured tables.

Verbose summaries show each table's applied gate reductions, rewrite count,
improving-match percentage, and accumulated lookup worker-seconds (including
truth-table calculation, cache access, and database wait). Overlapping lookups
can overlap in that time total; it is not elapsed job time. A match is counted
before overlapping windows are filtered, while reductions count only applied
replacements. These figures show contributions under the chosen lookup order,
not isolated speedups or proof that another table could not make the same rewrite.
Normal progress stays compact.

### Stable generation progress

Updates follow `timing.databaseLogSeconds` and show just one overall percentage
and one ETA, for example:

```text
Rainbow generation: ~7.27% complete | ETA ~19d 11h
```

The percentage measures committed input-row work across all expansion layers,
rather than completion of the current layer. Before all layer sizes are known,
future sizes are projected from the latest observed growth ratio (initially the
gate catalog size); `~` marks that estimated denominator. Estimates can move
backward when a larger frontier is discovered. At the final expansion layer,
all input totals are known and the percentage uses those measured totals. With
direct final-layer writing, there is no separate final frontier-draining phase.
This is a work percentage, not an exact fraction of elapsed runtime.

The single ETA uses a conservative recent rate: the slower of a smoothed median
and the recent lower throughput quartile. This reacts to sustained slowdowns
without allowing one isolated slow interval to dominate once four samples exist.
After five samples, a robust pairwise fit estimates increasing per-row cost
against logarithmic processed work and integrates that trend over remaining work.
`database.etaMaximumSlowdown: 4` bounds the forecast average cost relative to the
current conservative cost; set it to `1` to disable trend extrapolation. This cap
limits unstable early extrapolation, not the actual slowdown a build can suffer.

Speed estimates warm up for `database.etaWarmupSamples` reports, retain
`database.etaWindowSamples` samples and smooth the median using
`database.etaSmoothing`. A sample window below five disables the trend fit.
Layer transitions reset speed learning because processing cost can change.
Future layer sizes are still projected, so their ETA carries `(rough)`; it is not
a calibrated confidence bound. This model cannot foresee cache exhaustion, a
change in disk contention, different costs in unseen layers, or final compaction
time. It reduces constant-speed optimism rather than guaranteeing a deadline.
Per-layer work survives restart, while speed/trend samples relearn without
counting pre-restart work as new processing. Stalls are labeled as waiting for
progress. `100.00%` is reported after cleanup and compaction succeed. Normal
updates still contain one overall percentage and one ETA; internal timings
appear only with verbose logging.

### Automatic cleanup and compaction

Generation automatically removes `BuildSeen`, `BuildFrontier`, `BuildLayers`,
the three replacement-cost columns, and unnecessary build counters. It retains
only the lookup key/payload table and the small signature/depth/completion records
used to establish canonical coverage. An ordered table rewrite strips all three
cost columns together. SQLite `VACUUM` then compacts the file; WAL checkpoints
truncate the journal before and after compaction.

Cleanup commits atomically with a durable “awaiting compaction” status. If cleanup
fails, its transaction rolls back. If vacuum fails or the process stops, restart
the same job: it retries finalization without regenerating the completed output.
Normal progress stays at `99.99% complete | ETA finishing` until this succeeds;
ready tables are reused without repeating compaction. The old
`keepGenerationState` option is removed because completed tables always clean up.

Compaction adds disk work and needs temporary free space. SQLite documents that
`VACUUM` can require up to twice the database file size in additional free space:
[SQLite VACUUM documentation](https://sqlite.org/lang_vacuum.html). The generator
does not report success if compaction fails, including insufficient disk space.

### Generation benchmarks

```sh
npm run benchmark:generation
npm run benchmark:generation -- --smoke
npm run benchmark:generation -- --reference /absolute/path/to/compiled/reference/repository
```

`benchmark.generationTables` defaults to 3-wire/3-gate and 4-wire/2-gate fixtures.
`benchmark.repeats` and `benchmark.workerCounts` set the repeated build matrix;
`benchmark.generationTimeoutSeconds` bounds each child process. Smoke mode uses
2-wire/2-gate and 2-wire/3-gate tables, one repetition and 1/2 workers. Every trial
uses a fresh temporary database and process; it never touches the production
portfolio. The current variant honors the selected `OPTIMIZER_CONFIG`; an
optional reference repository uses its own JSON settings and compiled `dist`.
The reference is a benchmark-only comparison, not a production compatibility mode.

The report under `files.dataDirectory` / `benchmark.generationOutputName` records
settings, revisions, dirty-working-tree state, a compiled-generator fingerprint, build duration, row count, sampled peak database/journal
bytes, final file bytes, and peak process RSS (including output validation).
Temporary staging-file space is not included in the sampled database total.
All output replacements are checked exhaustively against their keys. A digest
compares complete coverage and replacement costs across variants, repetitions,
and worker counts, allowing different equally cheap gate sequences. Validation
runs after the measured generation interval. Alternating variant order reduces
ordering bias; small fixtures do not establish production 4/5 throughput.
`npm test` includes a fresh-process generation-benchmark smoke regression, with
no machine-dependent speed threshold.

## Bounded local synthesis

The `synthesis` section controls additional local optimizers:

- `templates` enables target/control-safe structural identities and pair merging before lookup. Exact rewrites are learned as normalized templates only after exhaustive verification; `templateEntries` bounds the cache.
- `smt` enables Z3 counterexample-guided synthesis. Candidate gate fields are symbolic; counterexamples refine them until local equivalence is proven. `timeoutMs` bounds search after WASM startup, and helper threads are cleaned up after every attempt.
- `meetInMiddle` searches small bijective functions bidirectionally using self-inverse gates with targets separate from controls.
- `equalitySaturation` explores bounded equivalent circuit sequences through commuting alternatives and templates, then selects the cheapest discovered circuit.

SMT, meet-in-the-middle and equality saturation remain opt-in. Scope is limited
by `maximumWires`, `maximumWindowGates`, `maximumReplacementGates`, `attemptEvery`,
`states` and `timeoutMs`. Optional synthesis runs after ordinary local search
fails and is serialized per worker. Returned replacements are exhaustively
checked. Timeouts are heuristic failed attempts, not proofs of impossibility.
Global checkpoint verification remains probabilistic.

## Search-loop overhead controls

- Progress keeps chunk references and an updated gate count. Full snapshots are materialized only for a requested reduced snapshot or completed pass, rather than after every local rewrite.
- A rewrite applies removals and replacements in one pass. With `search.incrementalDependencies=true`, stable gate IDs retain dependency edges across rewrites; only users of edited wires have their edges recomputed. Numeric graph views are still materialized for subset selection. Set the flag to `false` to use full reference graph construction.
- Window fingerprints use prefix hashes for constant-time range fingerprints. Hashes are only prefilters: remembered failures require an exact structural key. `cache.windowKeyBytes` bounds estimated retained key storage per method, in addition to `cache.processedEntries`; exceeding the budget clears that method's window memo. Hash collisions cannot silently suppress a different window.
- Concurrent lookups on the same SQLite connection share in-flight IDs and combine pending requests. `database.lookupBatchMilliseconds=0` batches in the next microtask without a timer delay; a positive value adds a short batching window. Hits and misses are copied into each caller's cache, and failures release pending requests for retry.
- `workers.jobsPerWorker` controls the number of smaller contiguous jobs per worker slot (default four); `workers.jobSeconds` sets a job's cooperative time budget (default 30 seconds). Idle workers take the next queued job. Results and intermediate checkpoints are assembled in original job order, regardless of completion order.

Round timing is still an upper/early-finish target; a round can finish sooner
when all jobs finish. The shared round stop signal returns queued jobs unchanged
and asks active jobs to finish between steps. Workload history excludes queue wait
time. Normal status distinguishes active workers from queued jobs, and queued
jobs do not trigger stale-worker warnings. Smaller jobs may trade cross-boundary
search opportunities for scheduling responsiveness; later rounds repartition and
shuffle the circuit. Increasing job size can favor larger search neighborhoods.

## Lookup reuse and search adaptation

Rainbow windows are evaluated into packed bitsets once on their actual used
wires. Keys are serialized directly to the existing packed table format. A wider
table key extends the untouched inputs/outputs of that same function; fallback
across widths or depths does not re-evaluate the gates. Keys for repeated table
widths are cached for the lookup call. Sliding-window wire counts are updated as
gates enter and leave each window, rejecting windows wider than the portfolio
before allocating gate slices or mappings. No table regeneration is needed.

Search settings:

- `search.localSearch: true` tries convex subsets seeded near the boundaries of a recent rewrite before the ordinary traversal. The same dependency-convex subset constructor is used for both paths.
- `localSearchSeeds: 32` and `localSearchRadius: 16` bound queued seed indices and their distance from the rewritten boundaries. Seeds are rebuilt after each edit, so stale circuit indices are not reused.
- `localSearchBroadEvery: 5` makes every fifth traversal begin with ordinary broader search. Every traversal still falls through to the ordinary search after its bounded seed queue if no rewrite interrupts it; normal worker time budgets still apply.
- `search.schedulerDecay: 0.98` discounts past scheduler observations after every recorded pass. Recent unproductive passes can outweigh earlier successes as the circuit changes. Set it to `1` for lifetime scoring; scheduled exploration remains enabled.

Verified successes from small rewritten windows are learned as normalized
structural templates. With `workers.shareTemplates: true`, each worker sends up
to `sharedTemplateBatch: 16` queued rules on progress reports at most once per
`sharedTemplateSeconds: 15`, plus one bounded batch at job completion. The timing
is checked when a progress report occurs, so it is a target rather than an exact
timer. `sharedTemplateEntries: 64` bounds each worker's pending export queue and
the parent relay's retained bank. Newly created workers receive the retained
rules in bounded batches; existing peers receive new successes. The ordinary
local template cache is still bounded by `synthesis.templateEntries`.

Senders, the relay, and receivers exhaustively check local equivalence before
admitting a shared rule. Template windows remain limited by
`synthesis.maximumWires` and `synthesis.maximumWindowGates`. Only improving rules
are admitted, a better existing rule is retained, and imported rules are not
echoed back. Subset failure keys include the local template revision, so newly
learned/imported rules can retry previously unsuccessful subsets. Failed-search
caches are not shared. Set `workers.shareTemplates`
to `false` to keep learned rules local. Sharing and extra verification have costs;
full-job gate reductions per second should be measured on the actual circuit
before tuning these defaults. Full-scale throughput gains are not yet measured.

## Eliminating repeated search work

An unchanged subset shares its template scan and fingerprint encoding across
slice sizes. Template revision changes invalidate the prepared template result;
rewrites create a new preparation. Each valid slice size runs once, bounded by
the subset length. Exact window keys slice a pre-encoded gate representation;
rolling fingerprints remain prefilters only. The window-key memory estimate
also charges the retained backing encoding, conservatively, once per preparation
and cache budget cycle.

A table fallback is omitted only when both tables have verified complete
canonical generation metadata and an earlier table has enough wires for the
window and at least the later table's gate depth. Verification checks completion,
finished build depth, and the exact current catalogue signature in `BuildMeta`.
Unknown, absent, mismatched or unreadable metadata disables this pruning, without
changing table loading or its data format. A hit rejected for borrowing absent
wires also disables that table's coverage proof for the window: its stored
winner can hide an equally cheap permitted alternative. Tables must remain unchanged while a
search uses them. This does not enable borrowing absent wires. For example, a
verified 3-wire/6-gate table covers all permitted 3-wire replacements that a
4-wire/5-gate table could return; 4-wire windows still consult the wider table.

Rainbow matches in one pass are selected with weighted interval scheduling,
maximizing total removed gates among the non-overlapping matches found. Ties
prefer summed local used-wire savings, then read savings. These secondary scores
are local costs, not a proof of globally minimal wire usage. Selection does not
search new functions or compare every table after an improving match has already
been found. Variable elimination retains its existing replacement selection.

`database.statementCacheEntries` (default `16`) bounds prepared lookup statements
per connection, keyed by batch size and evicted by least recent use. Lookups on
each connection serialize statement bindings, reset statements after use, and
discard failed statements. Closing a portfolio finalizes them before SQLite is
closed. Internal callers opening lookup connections directly must use
`closeRainbowTable` for the same cleanup.

`search.circuitChunkGates` (default `128`) controls chunked gate and stable-ID
storage. Edits copy affected chunks and coalesce small neighboring chunks;
untouched chunks are retained. Stable IDs use chunk-local handles, avoiding a
full gate-position map rebuild. Prefix offsets still update across chunks, and
numeric dependency views still materialize for traversal. Wire-list updates can
still touch many gates; this is not a claim that every graph operation is local.
The production progress path retains chunk references and flattens them for
requested snapshots or completed passes. Disabling incremental dependencies
still uses the full reference graph path.

These changes are covered by reference and randomized correctness tests.
Full-job throughput and the best chunk/cache sizes remain workload-dependent
and have not been benchmarked on the full circuit.

## Resource-aware search and benchmarks

Scheduler history is retained in each persistent worker. With
`search.stableSearchArms: true` (now opt-in), a deterministic spread of subset/slice sizes and
methods is reused across jobs, rather than replacing all choices with new random
ones. `search.schedulerHistoryEntries: 128` bounds history even when stable arms
are disabled. Decay is applied lazily to the updated score, avoiding a scan of
all historical scores on every pass. Set `stableSearchArms` to `false` to retain
random job-specific choices for comparisons.

Cache updates no longer evict unrelated entries when a full cache already holds
the updated key. `cache.lookupPolicy` is `"lru"` by default for lookup caches;
`"fifo"` retains insertion-order eviction. Other caches keep FIFO behavior.

### Shared small tables

`database.sharedTables: true` admits completed tables with verified canonical
metadata to a shared-memory lookup index before search workers start.
`sharedTableBytes: 33554432` is the total backing-buffer budget across tables;
`sharedTableMaximumRows: 100000` bounds each table and the admission scan. Tables
that exceed either limit continue using SQLite. Snapshot creation has temporary
JavaScript allocation overhead in addition to the retained buffer budget.

One parent builds the indexes; workers read the same `SharedArrayBuffer` backing
storage, without their own full copies or small-table database connections.
Exact key comparison resolves hash collisions, empty replacements remain hits,
and missing keys return misses. The implementation exposes only reader operations
to workers; shared memory is not an operating-system-enforced read-only mapping.
Do not modify table files during a job. Shared hits are decoded on demand and do
not populate the per-worker lookup cache with duplicate table rows/misses.

Enabling `search.independentComponents` (now opt-in) groups gates connected by used wires at each
search pass. Disjoint groups commute, so each group can be optimized separately
while preserving its internal gate order. Controls aliased with targets and
unused control fields are handled through the same used-wire definition as the
solver. A fully connected circuit remains one group. Component grouping can
change output gate order while preserving all outputs. The normal inner-chunk
limit applies within this partitioning; there can be more components than that
limit, bounded by the circuit's used wires.

### Adaptive worker concurrency

With `workers.adaptiveConcurrency: true`, search starts with up to
`initialConcurrency: 4` workers, still respecting CPU/configuration/environment
caps and circuit-size limits. `concurrencySampleRounds: 2` aggregates completed
rounds before throughput/database-driven changes. The controller probes adjacent
worker counts, rejects unproductive increases, and can accept fewer workers when
productivity stays within `concurrencyRateTolerance: 0.05`. Small-circuit caps are
not treated as trials of a larger requested target, and zero reductions alone do
not justify increasing concurrency.

`concurrencyDatabaseFraction: 0.6` triggers conservative backoff when SQLite
lookups are outstanding for a high fraction of observed worker time. This uses
the union of outstanding lookup intervals per worker, including queue/native SQL
time, rather than summing overlapping calls. It is a pressure heuristic, not a
measurement of purely idle CPU time. Memory pressure compares process RSS with
`memoryBudgetMegabytes: 8192`, also capped by 80% of physical/constrained memory
when available. Memory-driven reductions retire idle workers to release their
caches. Active jobs are not terminated to change concurrency.

Changes apply between rounds, with a compact log only when the next target
changes. Round workloads and circuit difficulty also change; this is heuristic
control, not an isolated causal experiment. Set `adaptiveConcurrency` to `false`
to retain the existing fixed-cap scheduling behavior. `OPTIMIZER_WORKERS` is a
hard cap; disable adaptation if you want to avoid automatic reductions below it.

### Reproducible benchmark harness

```sh
npm run benchmark -- data/latest.json data/obfuscated.json
```

The original file is optional; omitting it validates against the starting input.
The harness uses existing completed canonical tables and never generates new
ones. It does not update working/latest/progress circuits. It writes a JSON
report to `files.dataDirectory` / `benchmark.outputName` (default
`data/benchmark.json`) and refuses to overwrite its input or settings files.

The `benchmark` section controls `seconds: 10`, `repeats: 3`,
`workerCounts: [1, 2, 4]`, `seed: 1729`, `maximumChecks: 0`, and
`maximumOverrunSeconds: 30`. Each trial gets a fresh process and worker caches,
the same starting circuit, and the same seed for each paired repetition. Order
alternates across repetitions. The optional positive `maximumChecks` is an
additional **per-job** work cap; zero disables it. Requested worker counts are
fixed during a trial to compare concurrency independently of the controller.

The `reference` variant disables shared indexes, component partitioning and
stable choices, uses lifetime scheduler scores and FIFO lookup eviction. It still
contains correctness fixes and bounded scheduler history. `tuned` uses the
configured features. Both disable adaptive concurrency for fixed-count trials;
actual control overrides are recorded per result. This is a feature comparison,
not execution of an older git revision or an ablation of each individual feature.

Reports include input/original hashes, settings, git revision, Node/platform/CPU
metadata, seeds, startup time, actual wall time, requested budget, gate counts,
reductions per second, peak sampled RSS, lookup/worker time and validation method.
Shared-table admission is included in startup time; wall time includes worker
startup, search and pool cleanup, and reduction rate uses that wall time. Small
jobs may complete before the requested budget. Stops are cooperative, so actual
time can exceed the budget; the overrun watchdog terminates stuck trial processes.
Validation is exhaustive through eight wires and probabilistic above that limit.
Seeds repeat random streams, not operating-system scheduling; multithreaded
results and timings can vary. Full-circuit production gains remain unmeasured.

## Feature ablations and benchmark cases

```sh
npm run benchmark:ablate -- data/latest.json data/obfuscated.json
npm run benchmark:cases
npm run test:benchmark
```

`benchmark:ablate` (or `benchmark.mode: "ablation"`) runs seven configurations:
`reference`, `shared-tables`, `components`, `stable-arms`, `decay`, `lru`, and
`tuned`. Each single-feature configuration differs from the common reference in
exactly one control. Shared tables, components, stable choices and LRU are forced
on in their own variants; the decay variant uses `benchmark.decayFactor` (default `0.98`), independently
of the production scheduler setting.
The combined `tuned` configuration uses production settings. Fixed worker counts
are still used in every trial, so this does not test the adaptive concurrency
controller or individually ablate previous correctness fixes.

Variant order is reversed/rotated across repetitions and worker counts. Summary
rows report medians, ranges, and per-seed rate ratios paired with the reference
at the same worker count. Missing or zero-progress references have no meaningful
ratio and are excluded from the ratio summary. One-feature results describe
changes around that reference; interactions can make their combined effect
different. Short time budgets and parallel scheduling introduce variance.

`benchmarks/cases.json` registers four versioned circuits: adjacent cancellations,
interleaved independent components, connected mixed reversible gates, and
non-bijective target/control aliasing. Each has a frozen complete truth table and
a deterministic rewrite-coverage bound. The fixture suite builds only its small
2-wire/2-gate and 3-wire/2-gate databases under
`files.dataDirectory` / `benchmark.caseOutputDirectory`, then writes individual
reports and `suite.json` there. It never generates the production table portfolio
or changes working/latest checkpoints. Manifest settings control the case budgets;
these default to two seconds, three repetitions, and 1/2/4 workers.

`benchmark.caseManifest` selects the registry. Fixture paths are relative to that
manifest. `benchmark:cases` verifies frozen truth tables and requires all trial
results to pass exhaustive validation without increasing gate counts.
`test:benchmark` runs the same seven variants on every case using a short smoke
profile (one worker, one seed, 0.2 seconds, at most 32 checks per job). Smoke timings
are diagnostic, not performance thresholds.

`npm test` also runs deterministic fixed-work regression checks against all
registered cases and configurations. These require the frozen function and known
simple reductions to remain intact. They assert no machine-dependent speed ratio.
Use the full timed case suite and a representative real-circuit ablation report
when reviewing a performance feature, and retain the JSON reports with their git
revision, settings and seeds for comparisons. Full workload reports need existing
completed tables and are not bundled with the small fixture suite.

Set `benchmark.variants` to an explicit list to run a focused comparison instead
of the default comparison/ablation matrix. For example:

```json
"variants": ["reference", "tuned-no-stable", "tuned-conservative"]
```

`tuned-no-stable` uses configured tuning with stable arms disabled;
`tuned-conservative` also disables component partitioning. Leave the list empty
to use the selected mode's standard variants. Case suites explicitly reset this
list so every registered feature is exercised. Adding a feature variant also
requires a test that proves it changes only its intended reference control.

### Recorded investigation and defaults

The versioned summaries in `benchmarks/results/2026-11-17-ablation.json` and
`2026-11-17-confirmation.json` record 63 one-feature trials and 27 focused
confirmation trials on the 237,224-gate / 64-wire original circuit. They used
3-wire/3-gate, 4-wire/2-gate and 5-wire/2-gate tables because the production 4/5
library was unavailable. Every trial requested ten seconds, with three seeds at
1/2/4 workers. These are descriptive, short-budget results, not significance tests
or a guarantee for later solver phases.

Stable arms and component partitioning showed short-budget regressions. Disabling
stable arms alone did not resolve the combined slowdown; the confirmation with
both disabled was more robust at two workers. Both features now default to
`false`, while remaining available in the ablation variants and fixture suite.
Shared tables, LRU and decaying scores remain configurable and enabled; the new
combined default corresponds to the tested `tuned-conservative` settings. Benefits
were not uniform across seeds or worker counts, and absolute and paired medians
can disagree because search progress is bursty. Inspect the per-seed ratios and
absolute rates rather than interpreting one aggregate as a universal speedup.

These runs mostly exercise initial jobs and do not establish the long-running
benefit of persistent scheduler learning. The small deterministic cases prove
function preservation and simple rewrite coverage, not production throughput.

### Recorded generation comparison

`benchmarks/results/2026-11-17-generation.json` records 60 fresh builds against
main revision `e0eb2fb`: three repetitions with alternating reference/current
order. Small fixtures (3/3 and 4/2) used 1/2/4 configured workers; larger fixtures
(3/4 and 4/3) used 1/4. The 4/3 builds produced 832,167 verified functions, with
median build times of approximately 35.7s → 14.9s at one worker and 33.4s → 15.0s
at four. The 3/4 medians improved approximately 1.3–1.4×; smaller fixtures improved
approximately 2.0–2.3×. Every coverage/cost digest matched across implementations
and worker counts. These earlier measurements had smaller file sizes even before vacuum; they preceded automatic completion compaction.

These are combined changes on a shared host, not isolated-feature estimates or
significance tests. They do not establish throughput or final size for the full
4-variable/5-gate build. Per-trial samples and database controls are included in
the summary. Measurements preceded removal of the unused `insertBatchSize` knob
and minor validation/progress-only cleanup, and preceded automatic completion compaction. The generation benchmark now includes that finalization work; measured compiled fingerprints are
retained separately from the base git revision.
