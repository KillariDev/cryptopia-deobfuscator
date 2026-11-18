"""Generate a 100,000-gate puzzle hiding a known 1,000-gate circuit.

Run from any directory; --check verifies the saved artifacts without writing.
Nonlinear reversible changes of basis deliberately make expanded Boolean
polynomials expensive. Equivalence is proved structurally, without expanding
them, and also checked on 256 deterministic inputs with bit-parallel simulation.
The supplied solution is a known equivalent circuit, not a claimed optimum.
"""
import argparse
import hashlib
import json
import random
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
NAME = 'nonlinear-basis-maze'
SEED = 20261120
WIRES = 64
HALF = WIRES // 2
DEPTH = 5
TOTAL = 100000
CORE = 1000


def generate():
    rng = random.Random(SEED)
    # F G F G has twice the gates in the tree pair. Each internal node has
    # a forward and inverse basis; each of the 64 leaves contributes one gate.
    nodes = 2 * (2 ** DEPTH - 1)
    basis_total = ((TOTAL - CORE) // 2 - 2 ** (DEPTH + 1)) // 2
    short, longer = divmod(basis_total, nodes)
    lengths = [short + (i < longer) for i in range(nodes)]
    cursor = 0

    def basis(length):
        word = []
        while len(word) < length:
            if rng.randrange(5) == 0:
                control, target = rng.sample(range(HALF, WIRES), 2)
                gate = [control, 0, target, 3]
            else:
                a, b, target = rng.sample(range(HALF), 3)
                kind = rng.randrange(10)
                gate = [a, b, target, 1] if kind < 8 else [a, 0, target, 3]
            if not word or gate != word[-1]:
                word.append(gate)
        return word

    def tree(depth):
        nonlocal cursor
        if depth == 0:
            a, b = rng.sample(range(HALF), 2)
            return [[a, b, rng.randrange(HALF, WIRES), 1]]
        length = lengths[cursor]
        cursor += 1
        conjugator = basis(length)
        return conjugator + tree(depth - 1) + tree(depth - 1) + conjugator[::-1]

    f, g = tree(DEPTH), tree(DEPTH)
    assert cursor == nodes
    # Unique monomials avoid simply padding the known solution with duplicates.
    choices = [[a, b, target, 1] for target in range(HALF, WIRES)
               for a in range(HALF) for b in range(a + 1, HALF)]
    solution = rng.sample(choices, CORE)
    gates = []
    for i, block in enumerate((f, g, f, g)):
        gates.extend(block)
        gates.extend(solution[i * (CORE // 4):(i + 1) * (CORE // 4)])
    assert len(gates) == TOTAL
    return gates, solution, lengths


def verify_structure(gates, solution, lengths):
    """Check the emitted gates against a compositional all-input proof.

    A shear is (x,y) -> (x,y XOR h(x)). Shears commute and square to identity.
    A basis B=(p(x),Ay), with p reversible and A invertible linear, conjugates
    shears to shears. Distinct-control NOT/CNOT/Toffoli gates are self-inverse,
    so reversing a basis word gives its exact inverse. Induction verifies both
    trees, then F S0 G S1 F S2 G S3 = S0 S1 S2 S3.
    """
    assert len(gates) == TOTAL and len(solution) == CORE
    assert len({tuple(gate) for gate in solution}) == CORE
    assert len(lengths) == 2 * (2 ** DEPTH - 1)
    assert all(isinstance(v, int) and 0 <= v < WIRES for gate in gates for v in gate[:3])
    cursor = 0

    def shear_gate(gate):
        a, b, target, function = gate
        assert function == 1 and 0 <= a < b < HALF and HALF <= target < WIRES

    def tree(start, depth):
        nonlocal cursor
        if depth == 0:
            a, b, target, function = gates[start]
            shear_gate([min(a, b), max(a, b), target, function])
            return start + 1
        length = lengths[cursor]
        cursor += 1
        assert length > 0
        basis = gates[start:start + length]
        assert len(basis) == length
        for a, b, target, function in basis:
            if target < HALF:
                assert function in (1, 3) and a < HALF and a != target
                if function == 1:
                    assert b < HALF and b != a and b != target
            else:
                assert function == 3 and HALF <= a < WIRES and a != target
        end = tree(tree(start + length, depth - 1), depth - 1)
        assert gates[end:end + length] == basis[::-1], 'Basis inverse mismatch'
        return end + length

    f_end = tree(0, DEPTH)
    s0_end = f_end + CORE // 4
    g_end = tree(s0_end, DEPTH)
    s1_end = g_end + CORE // 4
    f_length, g_length = f_end, g_end - s0_end
    assert gates[s1_end:s1_end + f_length] == gates[:f_end], 'F mismatch'
    s2_start = s1_end + f_length
    g2_start = s2_start + CORE // 4
    assert gates[g2_start:g2_start + g_length] == gates[s0_end:g_end], 'G mismatch'
    s3_start = g2_start + g_length
    actual_core = (gates[f_end:s0_end] + gates[g_end:s1_end]
                   + gates[s2_start:g2_start] + gates[s3_start:])
    assert cursor == len(lengths) and actual_core == solution
    for gate in actual_core:
        shear_gate(gate)


def sampled_verification(gates, solution):
    rng = random.Random(SEED ^ 0xC0FFEE)
    inputs = [rng.getrandbits(256) for _ in range(WIRES)]

    def evaluate(circuit):
        state = inputs.copy()
        for a, b, target, function in circuit:
            if function == 1:
                state[target] ^= state[a] & state[b]
            elif function == 3:
                state[target] ^= state[a]
            else:
                raise AssertionError('Unexpected gate')
        return state

    assert evaluate(gates) == evaluate(solution), 'Simulation mismatch'


def circuit_text(gates):
    return ('{\n  "wire_count": ' + str(WIRES) + ',\n  "gate_count": '
            + str(len(gates)) + ',\n  "gates": [\n'
            + ',\n'.join('    ' + json.dumps(gate) for gate in gates) + '\n  ]\n}\n')


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--check', action='store_true')
    parser.add_argument('--output-root', type=Path, default=ROOT)
    args = parser.parse_args()
    gates, solution, lengths = generate()
    verify_structure(gates, solution, lengths)
    sampled_verification(gates, solution)
    puzzle_text, solution_text = circuit_text(gates), circuit_text(solution)
    proof = {
        'seed': SEED, 'wire_count': WIRES, 'gate_count': TOTAL,
        'known_solution_gate_count': CORE, 'optimality': 'Not claimed.',
        'nonlinear_gate_count': sum(gate[3] == 1 for gate in gates),
        'recursive_depth': DEPTH, 'basis_lengths_preorder': lengths,
        'construction': 'F S0 G S1 F S2 G S3; S0..S3 partition the known solution.',
        'proof': 'Every leaf is a lower-controlled upper-target shear. Every basis '
                 'is a reversible nonlinear map on the lower half and an invertible '
                 'linear map on the upper half. Each tree is therefore a shear by '
                 'conjugation and composition. All trees and core gates commute '
                 'and each tree is an involution, so F and G cancel exactly.',
        'verification': 'All-input structural certificate checked against emitted '
                        'gates, plus 256 deterministic bit-parallel sample inputs.',
        'difficulty': 'Dense nonlinear lower-half bases grow intermediate ANFs '
                      'beyond symbolic resource limits; this is a stress case, '
                      'not a claim of mathematical unsolvability.',
        'circuit_sha256': hashlib.sha256(puzzle_text.encode()).hexdigest(),
        'solution_sha256': hashlib.sha256(solution_text.encode()).hexdigest(),
    }
    artifacts = {
        args.output_root / 'data' / f'{NAME}.json': puzzle_text,
        args.output_root / 'data' / f'{NAME}-solved.json': solution_text,
        args.output_root / 'proofs' / f'{NAME}-proof.json': json.dumps(proof, indent=2) + '\n',
    }
    for path, content in artifacts.items():
        encoded = content.encode('utf-8')
        if args.check:
            assert path.read_bytes() == encoded, f'Artifact differs: {path}'
        else:
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_bytes(encoded)
    print(f'{"Verified" if args.check else "Generated"} {NAME}: {TOTAL:,} gates, '
          f'{CORE:,}-gate known solution; structural proof and 256 samples passed')


if __name__ == '__main__':
    main()
