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
whole-circuit quadratic fit. The cubic fallback in quadratic shear interpolation
can handle this fixture. Run the generator with `--check` to verify the
checked-in artifacts and repeat the packed comparisons.
