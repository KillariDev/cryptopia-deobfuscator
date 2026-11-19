Puzzle generators write puzzles and their known solutions to `data/`, and
verification certificates to `proofs/`. Run them from any working directory.

```sh
python3 generators/generate-tangled-not.py
python3 generators/generate-recursive-affine-maze.py
python3 generators/generate-nonlinear-basis-maze.py
```

`nonlinear-basis-maze` has exactly 100,000 gates on 64 wires. Its reference
circuit has 1,000 distinct Toffoli gates; this is a known solution, with no
claim that it is optimal. Four 250-gate sections of the reference circuit are
interleaved through recursively conjugated nonlinear masks.

The masks use reversible nonlinear changes of basis on the lower 32 wires,
and linear changes of basis on the upper 32. Each complete mask restores the
lower wires and XORs functions of them into the upper wires. Such masks and
all reference gates commute. Each mask is also an involution, so the repeated
mask pair cancels exactly, leaving the reference circuit. The generator checks
these invariants and the inverse/repetition layout against the emitted gates.
It also compares both circuits on 256 deterministic input samples.

This construction targets polynomial expansion: nonlinear basis changes can
make intermediate expressions exceed the symbolic solver's resource limits
before the masks cancel. It is a practical stress case; eventual solver
failure is not guaranteed.

Verify the saved artifacts, including deterministic reproduction and hashes:

```sh
python3 generators/generate-nonlinear-basis-maze.py --check
```

Generate elsewhere with `--output-root /path/to/output`. Start solving with:

```sh
npm run optimize -- data/nonlinear-basis-maze.json
```

## Shuffled cubic maze

Run `python3 generators/generate-shuffled-cubic-maze.py` to build a
19,560-gate mixed-degree challenge and its known 104-gate implementation.
The generator constructs nested nonlinear basis changes and shuffles adjacent
commuting gates. The proof metadata records the shuffle count and an eight-input
witness of a nonzero cubic coefficient on wire 16. That witness rules out a
whole-circuit quadratic fit. The cubic fallback in polynomial shear interpolation
can handle this fixture. Run the generator with `--check` to verify the
checked-in artifacts and repeat the packed comparisons.

## Shuffled quintic maze

Run `python3 generators/generate-shuffled-quintic-maze.py` to build the
19,952-gate mixed-degree challenge and its known 496-gate implementation.
The circuit contains linear through quintic output terms. A 32-input
witness certifies a nonzero degree-five coefficient on wire 16, beyond
degree-four interpolation. The higher-degree fallback can handle it. The generator verifies
the reference on all 65,536 lower-input states with upper inputs zero,
using the shear construction to account for arbitrary upper inputs.
Use `--check` to regenerate and verify the checked-in artifacts.

## Rare product

Run `npx tsc && node experiments/solve-rare-product.mjs data` to generate
`data/rare-product.json` and `data/rare-product-solved.json`, compare solver
passes, and verify the replacement. The experiment generates both files from
a fixed seed.

The 2,376-gate fixture on 39 wires uses 33 differently ordered implementations
of the same 20-control flip. Each implementation restores all 18 borrowed wires
for arbitrary initial values. An odd number of these flips leaves wire 38
toggled exactly when inputs 0 through 19 are all one. The event has probability
`2^-20` under uniform inputs. The output delta has degree 20, beyond the
default interpolation cap of 8.

Before adding the strategy, a 15-second tuned optimizer trial with two workers
and the benchmark suite's small rainbow-table portfolio retained all 2,376 gates.
Direct whole-region calls to polynomial shear, ANF synthesis, factored synthesis,
block cancellation, and mixed-basis cancellation returned no replacement. SAT sweeping returned no
replacement within its five-second budget. Longer runs or larger lookup tables
could change the optimizer result.

The optimizer’s `decision-diagram-product` strategy composes the circuit with
reduced ordered binary decision diagrams, reads the conjunction from the changed
wire's output delta, and synthesizes a 72-gate borrowed-wire ladder. Comparing every output diagram
proves equivalence for all inputs. The existing exact ANF equivalence checker
independently confirms the replacement and rejects the identity. The diagram
run used 64,736 nodes including intermediates and took about 0.21 seconds on
the development machine.

To give the strategy the first broad-search turn, put `decision-diagram-product`
first in `search.broadStrategyOrder`. The strategy also participates in local
rotation and is enabled by default.
