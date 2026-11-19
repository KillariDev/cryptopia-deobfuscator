"""Generate a commutation-shuffled maze with certified quintic output terms."""
import argparse
import hashlib
import itertools
import json
from pathlib import Path
import random
import runpy

ROOT = Path(__file__).resolve().parent.parent
NAME = 'shuffled-quintic-maze'
SEED = 20261124
BASE = runpy.run_path(str(Path(__file__).with_name('generate-shuffled-cubic-maze.py')))
WIDTH, SPLIT = BASE['WIDTH'], BASE['SPLIT']


def flip_product(controls, target, borrowed):
    if len(controls) == 2:
        return [[*controls, target, 1]]
    scratch, *remaining = borrowed
    compute = flip_product(controls[:-1], scratch, remaining)
    flip = [scratch, controls[-1], target, 1]
    # The repeated compute restores scratch. The repeated flip cancels
    # the contribution from its original value.
    return [*compute, flip, *compute, flip]


def generate():
    rng = random.Random(SEED)
    borrowed = [13, 14, 15]
    witness = (0, 1, 2, 3, 4)
    core = flip_product(witness, SPLIT, borrowed)
    cut = len(core)
    for target in range(SPLIT, WIDTH):
        controls = rng.sample(range(13), 5)
        if target != SPLIT:
            core.extend(flip_product(controls, target, borrowed))
        core.extend(flip_product(controls[:3 + target % 2], target, borrowed))
        a, b, c, *_ = controls
        core.extend([[a, b, target, 1], [c, 0, target, 3]])
    gates, swaps = BASE['garble_shear'](core, rng, cut)
    return gates, core, swaps, witness


def verify(gates, core, witness):
    rng = random.Random(SEED ^ 0xBA5E)
    evaluate = BASE['evaluate']
    inputs = [rng.getrandbits(4096) for _ in range(WIDTH)]
    assert evaluate(gates, inputs) == evaluate(core, inputs)

    # Exact comparison of each shear's flip function. The construction proves
    # both circuits restore the lower wires and pass upper inputs through by XOR.
    count = 1 << SPLIT
    lower = []
    for wire in range(SPLIT):
        packed = bytes(sum(((sample >> wire) & 1) << (sample & 7)
                           for sample in range(base, base + 8))
                       for base in range(0, count, 8))
        lower.append(int.from_bytes(packed, 'little'))
    zero_upper = lower + [0] * (WIDTH - SPLIT)
    assert evaluate(gates, zero_upper) == evaluate(core, zero_upper)

    # XOR of the truth table restricted to the five controls is their ANF coefficient.
    assignments = list(itertools.product((0, 1), repeat=len(witness)))
    probes = [0] * WIDTH
    for position, wire in enumerate(witness):
        probes[wire] = sum(bits[position] << sample for sample, bits in enumerate(assignments))
    assert evaluate(gates, probes)[SPLIT].bit_count() % 2 == 1


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--check', action='store_true')
    args = parser.parse_args()
    gates, core, swaps, witness = generate()
    verify(gates, core, witness)
    circuit_text = BASE['circuit_text']
    files = {ROOT / 'data' / f'{NAME}.json': circuit_text(gates),
             ROOT / 'data' / f'{NAME}-solved.json': circuit_text(core)}
    proof = {
        'seed': SEED,
        'commuting_swaps': swaps,
        'gate_count': len(gates),
        'known_solution_gate_count': len(core),
        'quintic_witness': {'controls': witness, 'target': SPLIT, 'coefficient': 1},
        'exhaustive_lower_inputs': 1 << SPLIT,
        'sampled_full_width_inputs': 4096,
        'proof': 'The conjugated shears commute and each occurs twice. Commuting adjacent swaps preserve the map. The borrowed product gates restore their scratch wires, so both circuits are shears on the same lower wires.',
        'sha256': {path.name: hashlib.sha256(text.encode()).hexdigest()
                   for path, text in files.items()},
    }
    files[ROOT / 'proofs' / f'{NAME}-proof.json'] = json.dumps(proof, indent=2) + '\n'
    for path, contents in files.items():
        if args.check:
            assert path.read_bytes() == contents.encode(), f'Fixture differs: {path}'
        else:
            path.write_bytes(contents.encode())
    print(f'{NAME}: {len(gates):,} gates, {len(core)} reference gates, {swaps:,} commuting swaps')


if __name__ == '__main__':
    main()
