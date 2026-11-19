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

Output folders are created automatically. The optimizer verifies and saves the
best available improvement at checkpoint intervals and round end. Periodic
status summaries default to every 30 seconds. Cancellation is cooperative, so an optimization
step may take time to finish.

Latest checkpoints and progress folders are named after the input file and stored
beside it by default, so each puzzle keeps its own saved work. Set
`files.latestName` to customize the latest checkpoint suffix, or set
`files.progressDirectory` to place snapshots in per-puzzle folders under
`files.dataDirectory`.

Set `files.workerSnapshots` to `true` to save worker chunks for inspection.
Use a verified full circuit to resume.
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
- **Decision-diagram product synthesis:** compose a region exactly and recover a
  single output flip controlled by a positive conjunction of unchanged inputs.
  The pass uses bounded decision diagrams on up to 64 active wires, restores
  borrowed wires, and proves every output equivalent before accepting a shorter
  circuit. It orders read-only controls before written wires and can retry in
  numeric order when diagram construction exceeds its budget. Prioritize it with
  `decision-diagram-product` in either strategy order. The default adaptive
  mode ranks alternative orders when the first diagram grows quickly. It scores
  up to four orders on short windows using progress, live nodes, and allocations,
  then resumes the best order from its saved prefix. Set
  `strategies.decisionDiagramProduct.trialOrdering` to `"upfront"` to rank every
  region or `"off"` to skip trials. By default, the pass compacts unreachable
  nodes at gate boundaries and remaps cached operations whose operands and
  result all survive. Buckets keyed by the newer operand let it skip entire
  groups during compaction. Set `strategies.decisionDiagramProduct.reclaimNodes`
  to `false` to disable compaction.
- **Strategy rotation:** a worker keeps its strategy for the entire round and
  advances after a round without a gate reduction. The local and broad searches
  have separate strategy orders. The checked-in config starts both with
  polynomial shear interpolation. With an empty local priority list, split
  workers start with ANF synthesis when enabled, followed by truth-table lookup.
  When ANF synthesis is disabled and the list is empty, workers start at offset
  positions in the enabled strategy order. The broad lane keeps its strategy
  whenever it removes gates, regardless of which result wins.

The round summary reports worker counts by strategy. Set `search.strategyAdaptive` to false to use the fixed pipeline and
synthesis rotation. Failed-region caches are separate by strategy so each method
can try the same region.

Set `search.localStrategyOrder` or `search.broadStrategyOrder` to give
specific strategies priority. For example, this tries truth-table lookup before ANF synthesis in local
search and polynomial shear interpolation before SAT sweeping in broad search.

```jsonc
"search": {
  "localStrategyOrder": ["truth-table-lookup", "anf-synthesis"],
  "broadStrategyOrder": ["polynomial-shear-interpolation", "sat-sweeping"]
}
```

Omitted enabled strategies follow in their default order. Disabled and ineligible
strategies are skipped. The local order applies to adaptive rounds and to queuing
whole-circuit local jobs. With adaptive strategy selection disabled, split local
jobs use the fixed pipeline. The broad order applies in both modes.

### Search strategies

Scope indicates which priority list accepts the strategy. Broad dependency
cuts can also invoke local rewrite methods inside a cut.

| Strategy | Scope | What it does |
| --- | --- | --- |
| `anf-synthesis` | Local | Composes gates in algebraic normal form (ANF) and synthesizes affine, quadratic, and certain cubic maps. |
| `truth-table-lookup` | Local | Matches a region’s input/output behavior against precomputed tables of shorter gate sequences. |
| `variable-elimination` | Local | Removes wires or substitutes controls where the region’s behavior allows it. |
| `forward-semantic-search` | Local | Enumerates short gate sequences from the identity and deduplicates them by exact input/output behavior. |
| `commutation-search` | Local | Explores commuting gate swaps and removes spans whose endpoint states match. |
| `gf2-affine` | Local | Finds affine maps and rebuilds them with binary linear algebra. |
| `factored-synthesis` | Local and broad | Keeps Boolean expressions factored while simplifying them and attempts to emit a shorter circuit. |
| `block-cancellation` | Local and broad | Finds repeated blocks and proves when they cancel across intervening gates. |
| `sat-sweeping` | Local and broad | Uses SAT to prove that candidate expressions are equivalent, then uses those identities to simplify the circuit. |
| `basis-change-cancellation` | Local and broad | Tracks XOR contributions across reversible basis changes so matching contributions can cancel. |
| `smt-synthesis` | Local | Asks Z3 for a shorter sequence with the same behavior on every input of a small region. |
| `meet-in-the-middle` | Local | Searches from both the identity and the target function, then joins paths at the same intermediate function. |
| `polynomial-shear-interpolation` | Local and broad | Fits quadratic target flips from samples, with bounded higher-degree shear fallbacks. |
| `polynomial-region-search` | Broad | Searches larger regions and their subwindows using the enabled affine and ANF synthesis methods. |
| `dependency-cuts` | Broad | Builds regions from gate dependencies, including noncontiguous gates, and tries enabled rewrite strategies there. |

See the comments next to the order settings in `solver.config.jsonc` for the
default local and broad orders. Older strategy names still work in priority
lists and older group names still work under `strategies`.

Local GF(2) affine synthesis (`strategies.gf2Affine.enabled`, enabled by default) is selected among
the eligible synthesis choices. It is not an unconditional startup or worker
prepass. It searches affine runs and smaller subwindows inside the selected
region, using its own `strategies.polynomialLimits.maximumWindowGates` bound (default 256) and
`validation.maximumWires`, independently of the small synthesis limits.
Exact symbolic verification is required for every accepted reduction. The solver
also composes Boolean polynomials through mixed gates: nonlinear intermediates
may cancel to an affine map. It can rewrite that map directly, or find smaller
mixed subwindows whose final transformation is affine. Truly nonlinear maps and
singular affine maps are preserved.

ANF synthesis (`strategies.anfSynthesis.enabled`, enabled by default) can also
emit genuinely nonlinear results: NOTs, controlled XORs, AND-controlled flips,
and complemented variants. It orders target updates so all controls still have
their original input values, then recomposes the candidate and checks every output
polynomial exactly. The symbolic strategy also tries a limited cubic rewrite
when all cubic terms share a pair of unchanged inputs and an otherwise unused,
unchanged wire can temporarily be XORed with their product. The rewrite restores
that wire and cancels the effect of its original value. The affine emitter still handles general
invertible linear maps, including cyclic linear dependencies. Both local and
broad searches use ANF synthesis, sharing the existing symbolic resource
limits and worker lifetime. The original recursive affine maze synthesizes to its
known four-gate solution.

Mixed symbolic analysis is bounded by `strategies.polynomialLimits.maximumTerms` (default
100,000 stored monomials), `strategies.polynomialLimits.maximumOperations` (10,000,000 symbolic
operations per candidate), the wire limit, and the worker job deadline. Exhausting
any limit declines that candidate without dropping terms or accepting an
approximate equivalence.

A broad worker starts with the full circuit and scans overlapping coarse-to-fine
regions. Its default strategy order is SAT sweeping with bounded dependency cuts,
polynomial shear interpolation, basis-change cancellation, block cancellation,
polynomial region search, factored synthesis, and dependency cuts.
Rainbow lookup and variable elimination remain available inside dependency cuts
and in local search. Set
`strategies.satSweeping.cutsFirst` to true to try a small batch of ranked cuts before
the whole-region SAT attempt.

Polynomial shear interpolation (`strategies.polynomialShearInterpolation.enabled`)
uses packed samples to identify likely unchanged wires. It evaluates zero-, one-,
and two-bit inputs to fit quadratic flips. If the shear fit fails, it can try
an ordered quadratic map whose target updates read their controls before those
controls change. If both quadratic attempts fail, it tries degrees three and
higher in order, up to `strategies.polynomialShearInterpolation.maximumDegree`
(default 8). A degree-`d` fit checks all input subsets of up to `d` controls.
The emitter groups terms that share a product. A group needs `d - 2`
temporary wires outside its own controls. A restored wire can be used by later
groups, including groups where it acts as a control. Earlier probe evaluations
are reused across attempts. Higher-degree fitting stops at 65,536 probes per
fit, 64 million packed gate evaluations across new higher-degree probes, or when
even one term would exceed the available gate budget. If a global fit hits the
probe limit, the solver samples which controls each output responds to and
tries fitting the outputs on those smaller sets. Mismatches on preliminary
checks can suggest controls to add back. The normal verification step still
checks the entire replacement. Worker deadlines also apply. The solver stops at the first verified
improvement. The emitter packs compatible terms into a single gate and
tries a shared-output basis change when overlapping target expressions can
justify the cost of changing and restoring the basis. Broad search checks the
whole circuit first, then tries up to 16 sampled restore windows before its
regular windows. Each proposed window is verified independently.

Regions of up to 12 active wires are checked exhaustively. Larger regions use
the shared polynomial proof limits. An exact mismatch rejects the candidate.
If the proof runs out of resources, `strategies.variableElimination.sampleCandidates`
allows randomized fallback. The sample count grows with the larger of active
wire count and the logarithm of the original gate count. The automatic range is
4,096 to 65,536 tests, with `strategies.variableElimination.samples` as a
configurable floor. Strategy statistics record the verification method and the
number of inputs checked when applicable. Random samples can miss rare differences.

Eligible rounds start one broad worker alongside the chunk workers when the
configured worker cap is at least two. Broad jobs share that cap and are
queued with priority. A positive `workers.broadSearchSeconds` enables broad
work, and zero disables it. The value no longer sets an interval.
`workers.broadSearchIdleSeconds` is accepted for existing configs.

The broad lane and chunk lane keep separate candidates throughout the round.
Jobs in either lane can pick up their own lane's improvements. At round end,
the coordinator compares the complete broad result with the assembled chunk
result and verifies and saves the winner. A global splice can also be combined
with split results when its original span is unchanged by the split workers
and the splice passes an exact standalone equivalence check. Periodic status updates and checkpoints
also use the best complete candidate currently available. The round summary
reports both gate reductions, which result was kept, and each lane’s strategies.

`workers.jobSeconds` sets the budget for an individual job. Workers stop
cooperatively at the round boundary, with state, memory and circuit-size limits
also in effect. Legacy `synthesis.affineWholeCircuitSeconds` remains an alias
for enabling broad work.

Complete candidates are ordered by gate count, total distinct wire operands
summed across gates, then total wire-pair uses. In `7G 7P`, `P` counts one
use per unordered pair of distinct wires in each gate. A pair used in multiple
gates contributes once per gate.
Multiple workers search circuit chunks, retaining caches between jobs. For circuits
with at most 2,000 gates, workers instead run independent whole-circuit searches
and keep the best result, preserving opportunities across chunk boundaries. Each
strict gate-count improvement is immediately verified and saved, then active
searches stop cooperatively and queued jobs are discarded. The next round starts
from the new best; any better result returned while stopping is retained. The
coordinator verifies combined results before saving them. By default, improving
rounds use the `timing.improvedRoundSeconds` target. Rounds without reductions
use `timing.roundSeconds`. Later rounds repartition and shuffle the circuit.

Checkpoint verification is exhaustive when the original and candidate together
use at most eight wires. On wider resumes, the solver first tries an exact
Boolean polynomial proof. If the proof reaches a resource limit, the solver
checks at least 1,024 random inputs and logs when it resumes using that result.
A detected mismatch stops the run. Sampling can miss rare differences.
During a run, new wide checkpoints are checked against the original on
`validation.checkpointInputs` random inputs.

## Configuration

Edit [solver.config.jsonc](solver.config.jsonc), then restart. The checked-in file
documents each setting. Time settings use seconds, including fractional seconds
for short intervals. Existing minute and millisecond settings are still read
when their seconds equivalents are omitted. Omitted values use defaults. Set a strategy’s
`enabled` field under `strategies` to false to disable it. Shared solver limits
are listed in the same section. A file selected with `OPTIMIZER_CONFIG` can use
JSONC or the legacy JSON layout. When both layouts provide the same setting,
the grouped strategy value takes precedence. Job-specific circuit filenames
stay on the command line.

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
| `strategies` | Strategy switches, individual settings and shared solver limits |
| `benchmark` | Reproducible performance comparisons |

Useful settings to start with:

- `workers.wholeCircuitMaximumGates`: at or below this gate count, schedule a
  whole-circuit local job for every enabled strategy. With fewer workers than
  strategies, the remaining jobs queue. The default is 2,000. Set it to 0
  to disable this scheduling mode. Concurrency and memory limits still apply.
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
