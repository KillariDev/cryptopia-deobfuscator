# Cryptopia Deobfuscator

A TypeScript tool for simplifying obfuscated Boolean circuits. It searches for
smaller equivalent gate sequences, saves verified improvements, and keeps
searching across repeated rounds. It was originally built for
[Obfustopia](https://github.com/gausslabs/obfustopia).

The goal is to reduce the circuit, not recover its original source code. Search
is heuristic: it can keep finding improvements without proving that the result
is the smallest possible circuit.

## Getting started

Use Node.js 22 or newer. Install dependencies from the repository root:

```bash
npm ci
```

Put your original circuit in `data/obfuscated.json`, then run:

```bash
npm run optimize -- data/obfuscated.json
```

Pass the original puzzle file. The solver creates `data/obfuscated-latest.json`
and automatically resumes from it on subsequent runs. The original remains the
reference used to verify all saved improvements.

To restart from the original instead of the latest checkpoint:

```bash
npm run optimize -- data/obfuscated.json --startover
```

This replaces the latest checkpoint when optimization starts; earlier progress
snapshots remain available.

Circuit JSON contains `wire_count`, `gate_count`, and a `gates` array. Each gate
is `[controlWireA, controlWireB, targetWire, controlFunction]`.

At startup, the application prints its inputs, gate and wire counts, settings,
output locations and worker limits. It prepares any missing lookup tables before
starting circuit optimization, so the first run can spend substantial time and
disk space on setup.

## Saving and resuming

The solver runs continuously. Stop it with **Ctrl+C**, then run the same command
to resume from `data/obfuscated-latest.json`.

Default output locations:

| Location | Contents |
| --- | --- |
| `data/obfuscated-latest.json` | Most recently saved, verified full circuit |
| `data/obfuscated-progress/obfuscated.solved-<gate-count>.json` | Verified progress checkpoints |
| `data/worker/` | Worker chunk snapshots and disposable generation scratch files |
| `rainbow_<wires>_<gates>.db` | Reusable lookup tables |

Output folders are created automatically. Worker improvements are verified and
saved when reported; periodic summaries default to every 30 seconds. Completed
rounds can also save checkpoints. Cancellation is cooperative, so an optimization
step may take time to finish.

Latest checkpoints and progress folders are named after the input file and stored
beside it, so each puzzle keeps its own saved work.

Worker snapshots are for inspection; use a verified full circuit to resume.
Interrupted lookup-table generation resumes from its own database checkpoint.

## How it optimizes circuits

The solver combines several approaches:

- **Local structural rewrites:** cancel or merge compatible gates, apply known
  identities, and reuse small rewrites that were exhaustively verified.
- **Variable elimination:** find small regions where a wire or dependency can be
  removed while preserving the region's behavior.
- **Lookup-table replacement:** evaluate a small region's Boolean function and
  search precomputed rainbow tables for a cheaper implementation. Tables cover
  different wire counts and gate depths.
- **Dependency-aware search and shuffling:** choose regions using gate
  dependencies and reorder gates when that preserves behavior. Reordering can
  expose simplifications that were not adjacent before.
- **Local search:** prioritize recently changed regions. Adaptive search modes
  remain available through `search.adaptive`, but are off by default.
- **Synthesis rotation:** after cheap template, variable and rainbow rewrites
  stall, take turns in a fixed order: GF(2), quadratic synthesis, forward search, Z3, meet-in-the-middle,
  equality saturation. Disabled, ineligible and cached failures are skipped.
  Region sizes still vary so persistent workers explore different candidates.

Local GF(2) affine synthesis (`synthesis.affine`, enabled by default) is selected among
the synthesis rotation after local rewrites stall. It is not an unconditional startup or worker
prepass. It searches affine runs and smaller subwindows inside the selected
region, using its own `synthesis.affineMaximumWindowGates` bound (default 256) and
`validation.maximumWires`, independently of the tiny SMT/template limits.
Exact symbolic verification is required for every accepted reduction. The solver
also composes Boolean polynomials through mixed gates: nonlinear intermediates
may cancel to an affine map. It can rewrite that map directly, or find smaller
mixed subwindows whose final transformation is affine. Truly nonlinear maps and
singular affine maps are preserved.

Sparse quadratic synthesis (`synthesis.quadratic`, enabled by default) can also
emit genuinely nonlinear results: NOTs, controlled XORs, AND-controlled flips,
and complemented variants. It orders target updates so all controls still have
their original input values, then recomposes the candidate and checks every output
polynomial exactly. Dependency cycles, target-dependent deltas and degree above
two are declined by this emitter. The affine emitter still handles general
invertible linear maps, including cyclic linear dependencies. Both local and
broad searches use quadratic synthesis, sharing the existing symbolic resource
limits and worker lifetime. The original recursive affine maze synthesizes to its
known four-gate solution.

Mixed symbolic analysis is bounded by `synthesis.affineMaximumTerms` (default
100,000 stored monomials), `synthesis.affineMaximumOperations` (10,000,000 symbolic
operations per candidate), the wire limit, and the worker job deadline. Exhausting
any limit declines that candidate without dropping terms or accepting an
approximate equivalence.

A broad worker searches alongside the chunk workers, using the same toolkit:
templates, variable elimination, rainbow lookup and eligible synthesis solvers.
It starts with the full circuit and scans overlapping coarse-to-fine regions.
Variable and rainbow scans also use full-region and progressively smaller window
sizes, rather than inheriting the local slice cap; their wire limits still apply.
At most one broad job runs in a round, scheduled no more often than
`workers.broadSearchSeconds` (default 60 seconds; 0 disables broad work). The broad
job is queued first and shares the existing worker cap; with only one available
slot, jobs run serially. It cannot be starved behind the local job queue. After an improvement, broad
work is eligible immediately on the new baseline, rather than waiting for the
old baseline's cadence timer.

A broad improvement is a complete alternative circuit. It is never concatenated
with old chunk results. Verified improvements stop peer work, cancel queued jobs
and restart from the best complete candidate returned while stopping. Quiet
summaries distinguish broad strategy timings and show a running broad worker.

`workers.jobSeconds` is the only time limit (default 120 seconds, or two minutes).
All strategies use the job's remaining time and stop cooperatively when a better
result is found. State, memory and circuit-size bounds remain active. Legacy
`synthesis.affineWholeCircuitSeconds` is accepted as an alias for the broad cadence;
old per-strategy timer and attempt-cadence settings are accepted but ignored.

Replacements are ordered by gate count, then used-wire count and read cost.
Multiple workers search circuit chunks, retaining caches between jobs. For circuits
with at most 2,000 gates, workers instead run independent whole-circuit searches
and keep the best result, preserving opportunities across chunk boundaries. Each
strict gate-count improvement is immediately verified and saved, then active
searches stop cooperatively and queued jobs are discarded. The next round starts
from the new best; any better result returned while stopping is retained. The
coordinator verifies combined results before saving them. By default, improving
rounds aim to finish after five minutes; rounds without reductions retain a
25-minute budget. Later rounds repartition and shuffle the circuit.

Small rewrites can be checked exhaustively. Large-circuit checkpoint validation
uses random inputs, so a saved checkpoint is not a formal equivalence proof.

## Configuration

Edit [solver.config.json](solver.config.json), then restart. The checked-in file
lists all settings; omitted values use defaults. Invalid or unknown settings
fail at startup. Job-specific circuit filenames stay on the command line.

| Section | What it controls |
| --- | --- |
| `files` | Output folders, latest filename and lookup-table directory |
| `runtime` | Node heap budget |
| `workers` | Worker cap, job sizing, memory budget and concurrency adaptation |
| `timing` | Round budgets, status and checkpoint intervals |
| `logging` | Detailed diagnostics |
| `validation` | Equivalence-check sample counts and wire limits |
| `search` | Search methods, region sizes, caching and adaptive scheduling |
| `cache` | Per-worker cache limits |
| `database` | Lookup-table portfolio, database access and generation settings |
| `synthesis` | Local synthesis strategies, attempt frequency and search limits |
| `benchmark` | Reproducible performance comparisons |

Useful settings to start with:

- `workers.wholeCircuitMaximumGates`: use parallel whole-circuit searches below
  this gate count (inclusive); default 2,000, or 0 to always split into chunks.
  The adaptive concurrency and memory limits still apply.
- `workers.maximum`: upper bound on solver workers; the default cap is 24.
  Actual concurrency also depends on the circuit and resource limits.
- `runtime.heapMegabytes`: Node heap budget; the default is 16,384 MiB. SQLite,
  worker and other native allocations also consume memory.
- `logging.verbose`: detailed search and database diagnostics; defaults to false.
- `files.dataDirectory`: output root; defaults to `data`.
- `files.databaseDirectory`: lookup-table directory; defaults to the working directory.

Optional environment overrides are `OPTIMIZER_CONFIG` for another JSON settings
file, `OPTIMIZER_WORKERS` for the worker cap, and `OPTIMIZER_VERBOSE=1` or `0` for
verbose logging.

## Lookup tables

The default portfolio is:

```json
"tables": [
  { "wires": 3, "gates": 6 },
  { "wires": 4, "gates": 5 },
  { "wires": 5, "gates": 2 }
]
```

Edit `database.tables` to select which libraries to use. A table's wire limit
applies to a local search region, not the entire input circuit. Wider or deeper
tables cover more replacements but can cost substantially more to generate and
store.

Missing tables are generated automatically, completed tables are reused, and
compatible interrupted builds resume. Completed builds remove construction data
and compact the database automatically. Incompatible older formats require fresh
tables; there is no migration or compatibility mode.

## Reading progress

Solver status shows remaining gates, reduction from the original, current-round
improvements, saved-checkpoint state and worker activity. Gate reduction and
round-budget percentages are not percentages of the entire search completed.

Table generation shows one completion percentage and one ETA. Before all layer
sizes are known, these are estimates. The ETA follows recent measured throughput;
it cannot guarantee a finish time.

With `logging.verbose: false`, optimization prints a compact status and one short strategy/timing line per
`timing.summarySeconds` interval, even across rapid restarts. One run-wide timer also reports preparation and
between-round shuffling phases. Shuffling runs in a worker with the same job
lifetime; improvement-triggered restarts skip that shuffle. Checkpoints are still
saved immediately. Strategy summaries aggregate completed attempts since the last
summary across rapid restarts; times are summed per-strategy worker elapsed time,
not wall-clock time or CPU time. Broad GF(2) jobs also show elapsed time while
running. Individual save/restart messages, detailed strategy breakdowns and the
full startup settings dump are only printed in verbose mode.

With `logging.verbose: true`, additional reports show CPU, memory, SQL costs,
staging-writer utilization and committed work per second. Database-operation
timings identify expensive membership checks, lookup writes or frontier cleanup.
These diagnostics help distinguish productive parallel work from workers waiting
on the database; low CPU usage alone does not establish a disk bottleneck.

## Tests and benchmarks

```bash
npm test
npm run test:benchmark
npm run benchmark -- data/obfuscated-latest.json data/obfuscated.json
```

Tests cover circuit evaluation, rewrite correctness, lookup behavior, workers and
checkpoint recovery. Benchmarks compare performance on registered cases or your
own circuit. See the [benchmark guide](benchmarks/README.md) for feature comparisons
and database benchmarks, and [recorded results](benchmarks/results/) for previous
measurements.

For background on the original challenge, read
[Breaking the $10,000 iO Bounty](https://mirror.xyz/killaridev.eth/x2x6yFhovUQJxICCM8jJ7ezcjIvqyRN1iQfsWCG_Doc).

## Puzzle files

Puzzles and their `-solved.json` references live in `data/`. Reproducible Python
generators live in `generators/`; generated verification metadata lives in
`proofs/`. Generator output paths are relative to the repository, regardless of
the directory from which a generator is launched.

```bash
python3 generators/generate-tangled-not.py
python3 generators/generate-recursive-affine-maze.py
```

## Recursive affine challenge

`data/recursive-affine-maze.json` contains 46,220 gates on 32 wires: exactly 20
times the gate count of `tangled-not`. Four levels of affine conjugations mix
nonlinear shears recursively. GF(2) region synthesis can remove affine overhead but
cannot by itself recover cancellations across the nonlinear boundaries.

Run `python3 generators/generate-recursive-affine-maze.py` to reproduce the puzzle,
`data/recursive-affine-maze-solved.json`, and its metadata in
`proofs/recursive-affine-maze-proof.json`. The generator checks
exact algebraic normal forms for all outputs, proving equivalence for every
input. The four-gate solution is optimal because four distinct output wires
change and each gate affects just one target.

```bash
npm run optimize -- data/recursive-affine-maze.json
```

This is a stress case with a known solution; no full-solver runtime bound has
been established.
