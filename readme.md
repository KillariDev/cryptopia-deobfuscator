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
- `database`: rainbow circuit wire/gate limits, query/insert batch sizes, disk generation bounds, and ETA smoothing settings. Changing wire/gate limits selects a different database and may require building it.

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
`rainbow_<wires>_<gates>.db` under `files.databaseDirectory`. If the selected table
does not exist, the solver generates it; a completed table is used as-is.
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
- `database.generationBatchRows`: maximum candidate rows staged in JavaScript before a bulk SQL write.
- `database.generationStates`: optional distinct-function limit; `0` means unlimited disk-backed generation. Hitting a limit rolls back the current batch; increase the limit or set it to `0`, then restart to resume.
- `database.keepGenerationState`: retain working tables after completion for inspection. By default they are dropped; SQLite may retain freed pages in the database file.
- `database.memoryMapBytes`: mmap setting per connection; `0` disables mapping. SQLite can cap or disable mmap depending on its build.

Only build one copy of a particular table at a time. Disk requirements can still
be substantial; bounded RAM does not make the search space small. Completed
layers and partially processed layers are resumable without recomputing their
committed work. A smaller `database.gates` value builds a smaller library; enable
bounded on-demand synthesis for uncommon windows instead of precomputing every
larger replacement. Changing wire/gate limits selects a different table filename.

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
