"""Generate a commutation-shuffled maze with certified cubic output terms."""
import argparse
import hashlib
import json
from pathlib import Path
import random

ROOT = Path(__file__).resolve().parent.parent
NAME = 'shuffled-cubic-maze'
SEED = 20261123
WIDTH = 32
SPLIT = 16
BORROWED = 15


def cubic(a, b, c, target):
    compute = [a, b, BORROWED, 1]
    flip = [BORROWED, c, target, 1]
    # The two flips cancel the borrowed wire's original contribution.
    return [compute, flip, compute, flip]


def garble_shear(core, rng, cut):
    """Insert canceling shear blocks around a valid boundary in the core."""
    def tree(depth):
        if depth == 0:
            a, b, c = rng.sample(range(BORROWED), 3)
            return cubic(a, b, c, rng.randrange(SPLIT, WIDTH))
        basis = []
        for _ in range(160):
            if rng.randrange(4):
                a, b, target = rng.sample(range(SPLIT), 3)
                basis.append([a, b, target, 1])
            else:
                a, target = rng.sample(range(SPLIT, WIDTH), 2)
                basis.append([a, 0, target, 3])
        return basis + tree(depth - 1) + tree(depth - 1) + basis[::-1]

    first, second = tree(4), tree(4)
    # Each tree is a shear since its bases act separately on the two halves
    # and are linear on the upper half. The trees commute and square to identity.
    gates = first + core[:cut] + second + first + core[cut:] + second
    swaps = 0

    def controls(gate):
        return gate[:2] if gate[3] == 1 else gate[:1]

    for _ in range(len(gates) * 50):
        index = rng.randrange(len(gates) - 1)
        left, right = gates[index:index + 2]
        if left != right and left[2] not in controls(right) and right[2] not in controls(left):
            gates[index], gates[index + 1] = right, left
            swaps += 1
    return gates, swaps


def generate():
    rng = random.Random(SEED)
    # Disjoint triples on the same output guarantee a degree-three term and
    # defeat the special emitter that requires one pair shared by every cubic.
    core = cubic(0, 1, 2, SPLIT) + cubic(3, 4, 5, SPLIT)
    for target in range(SPLIT, WIDTH):
        a, b, c = rng.sample(range(6, BORROWED), 3)
        core.extend(cubic(a, b, c, target))
        core.extend([[a, b, target, 1], [c, 0, target, 3]])
    gates, swaps = garble_shear(core, rng, 8)
    return gates, core, swaps


def evaluate(gates, inputs):
    state = inputs.copy()
    for a, b, target, kind in gates:
        state[target] ^= (state[a] & state[b]) if kind == 1 else state[a]
    return state


def verify(gates, core):
    rng = random.Random(SEED ^ 0xBA5E)
    inputs = [rng.getrandbits(4096) for _ in range(WIDTH)]
    assert evaluate(gates, inputs) == evaluate(core, inputs)

    # The XOR of all eight readings is the coefficient of a*b*c with
    # every other input fixed to zero. A quadratic map has coefficient zero.
    probes = [sum(((sample >> wire) & 1) << sample for sample in range(8))
              if wire < 3 else 0 for wire in range(WIDTH)]
    assert evaluate(gates, probes)[SPLIT].bit_count() % 2 == 1


def circuit_text(gates):
    return ('{\n  "wire_count": ' + str(WIDTH) + ',\n  "gate_count": '
            + str(len(gates)) + ',\n  "gates": [\n'
            + ',\n'.join('    ' + json.dumps(gate) for gate in gates) + '\n  ]\n}\n')


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--check', action='store_true')
    args = parser.parse_args()
    gates, core, swaps = generate()
    verify(gates, core)
    files = {ROOT / 'data' / f'{NAME}.json': circuit_text(gates),
             ROOT / 'data' / f'{NAME}-solved.json': circuit_text(core)}
    proof = {
        'seed': SEED,
        'commuting_swaps': swaps,
        'gate_count': len(gates),
        'known_solution_gate_count': len(core),
        'cubic_witness': {'controls': [0, 1, 2], 'target': SPLIT, 'coefficient': 1},
        'sampled_inputs': 4096,
        'proof': 'The conjugated shears commute and each occurs twice. Adjacent swaps preserve the map when neither gate writes the other gate’s controls.',
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
