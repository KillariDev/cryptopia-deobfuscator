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

Output folders are created automatically. Every 30 seconds, the solver checks
for gate reductions and saves a verified improvement if one is available.
Completed rounds can also save checkpoints. These intervals are cooperative;
an optimization step may take time to finish.

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
- **Adaptive local search:** prioritize recently changed regions and methods
  that have found useful reductions, while continuing to explore other regions.
- **Bounded synthesis:** select randomly among enabled forward semantic search,
  Z3/SMT synthesis, meet-in-the-middle search and equality saturation on small
  regions. These methods are enabled by default, with limits on circuit size,
  search effort and time; each can be disabled in `synthesis`.

Replacements are ordered by gate count, then used-wire count and read cost.
Multiple workers search circuit chunks, retaining caches between jobs. For circuits
with at most 2,000 gates, workers instead run independent whole-circuit searches
and keep the best result, preserving opportunities across chunk boundaries. The
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
