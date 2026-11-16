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

The process saves progress checkpoints to `data/progress/<name>.solved-<gate-count>.json` and the most recent completed circuit to `data/latest.json`. Worker snapshots are stored in `data/worker/<name>_worker<index>.json`, updated before and after each worker job. Output folders are created automatically. You can exit from the program and run the command again to restart. The optimizer runs forever, so you need to exit from program with "ctrl c".
## Worker configuration

Use Node.js 22 or newer. The optimizer keeps a pool of workers alive across
rounds, retaining their bounded lookup caches and SQLite connections. Circuit
chunks are exchanged through worker messages; the files in `data/worker/` are
snapshots for inspection, not the worker communication mechanism. Completed
rounds still save verified checkpoints.

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
Workers report their most recent completed optimization step; candidate counts
are provisional until the completed round passes checkpoint verification.
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
is written to both the progress file and `data/latest.json`. Save frequency and
randomized verification guarantees are unchanged.
