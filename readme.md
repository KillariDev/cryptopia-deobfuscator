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
Interrupted builds resume automatically. There is no migration, rebuild command,
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

Generation settings:

- `database.queryBatchSize`: maximum frontier rows read per batch and the SQL parameter budget (at most 900).
- `database.generationBatchRows`: maximum raw candidate expansions per CPU task and maximum rows staged in JavaScript before a bulk SQL write. The gate catalog is split too if it exceeds this limit.
- `database.generationStates`: optional distinct-function limit; `0` means unlimited disk-backed generation. Hitting a limit rolls back the current batch; increase the limit or set it to `0`, then restart to resume.
- `database.keepGenerationState`: retain working tables after completion for inspection. By default they are dropped; SQLite may retain freed pages in the database file.
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
No table-format change or regeneration is required for this optimization.

Settings under `database`:

- `generationWorkers: 4`: maximum CPU slots, capped at available CPUs minus one (minimum one). A value of `1` runs the same optimized expansion in the writer process without worker threads. Threads start lazily and persist for the table build.
- `generationQueueBatches: 2`: maximum outstanding tasks per CPU slot, including running tasks and completed results awaiting consumption. Together with `generationBatchRows`, this bounds expansion buffering; the writer can additionally retain one staging buffer and the current `queryBatchSize` frontier rows.
- `generationMinimumWork: 100000`: batches below this many raw candidate expansions run inline. This avoids worker startup and message overhead for small tables and small layers. Lower it to exercise parallel expansion on smaller batches.

A task contains at most `generationBatchRows` raw expansions. SQLite's temporary
candidate table uses `temp_store=FILE` so staging can spill to disk (subject to
the SQLite build). It can hold up to `queryBatchSize × gate catalog size` distinct
candidates for a committed read batch; increasing frontier batch size can increase
temporary database space and time between checkpoints. State-limit enforcement
occurs after staging this batch, before commit. Different table files are not
built concurrently.

With verbose logging enabled, generation completion reports expanded/emitted
candidate counts, aggregate expansion worker-seconds, database work time, writer
wait for expansion, thread count, and peak pending tasks. Timings can overlap;
worker-seconds are not job wall time. These measurements help identify whether
CPU expansion or database work limits a build. Extra CPU workers cannot eliminate
a database bottleneck, and the defaults are conservative rather than a promise
of linear speedup. Full 4-wire/5-gate build throughput has not been benchmarked.

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

Updates follow `timing.databaseLogSeconds`. They show depth, the current layer's
completion percentage, functions indexed on disk and elapsed time for this run.
The layer ETA warms up for `database.etaWarmupSamples` reports, uses a rolling
median over `database.etaWindowSamples` rates, then smooths that rate with
`database.etaSmoothing` (lower values react more slowly). Layer changes reset the
estimate. Work committed before a restart contributes to percentage completion
but is not treated as work performed during the new timing sample.

An ETA is still approximate. Future layer sizes depend on deduplication, so an
overall ETA is explicitly unavailable rather than extrapolated from unstable
sequence-space coverage. Stalls are labeled as waiting for progress after the
sampling window fills with zero rates. Completion is logged after final writes.

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
