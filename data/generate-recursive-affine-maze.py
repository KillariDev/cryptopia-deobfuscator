"""Generate a recursively mixed, 46,220-gate challenge and its optimal solution.

Run: python3 data/generate-recursive-affine-maze.py
Each depth-four tree uses affine conjugations around nonlinear shears. The two
resulting shears F and G commute and are involutions, so F G F G is identity.
An independent algebraic-normal-form simulation verifies every output exactly.
"""
import hashlib
import json
import random
from pathlib import Path

OUT = Path(__file__).resolve().parent
NAME = 'recursive-affine-maze'
SEED = 20261119
WIRES = 32
DEPTH = 4
rng = random.Random(SEED)
node_lengths = []


def affine_word(length):
    word = []
    while len(word) < length:
        offset = rng.randrange(2) * 16
        if rng.randrange(8) == 0:
            gate = [0, 0, offset + rng.randrange(16), 15]
        else:
            control, target = rng.sample(range(offset, offset + 16), 2)
            gate = [control, 0, target, 3]
        if not word or gate != word[-1]:
            word.append(gate)
    return word


def tree(depth):
    if depth == 0:
        a, b = rng.sample(range(16), 2)
        return [[a, b, rng.randrange(16, 32), 1]]
    # There are 30 internal nodes across F and G. Their total affine-word
    # length is 11,538, giving exactly 20 * 2,311 gates including the solution.
    length = 385 if len(node_lengths) < 18 else 384
    node_lengths.append(length)
    basis = affine_word(length)
    inner = tree(depth - 1) + tree(depth - 1)
    # Every CNOT and NOT is its own inverse; conjugations preserve shears.
    return basis + inner + list(reversed(basis))


f = tree(DEPTH)
g = tree(DEPTH)
solution = [[0, 1, 16, 1], [2, 3, 18, 1], [4, 5, 20, 1], [0, 0, 17, 15]]
gates = f + g + f + g + solution
assert len(node_lengths) == 30 and sum(node_lengths) == 11538
assert len(gates) == 46220 == 20 * 2311


def exact_outputs(circuit):
    # A polynomial is a set of monomial bitmasks over GF(2). Multiplication
    # unions variable masks (x*x=x); symmetric difference adds modulo two.
    rows = [{1 << i} for i in range(WIRES)]
    for a, b, target, function in circuit:
        if function == 3:
            assert (a < 16) == (target < 16), 'basis transforms must preserve halves'
            rows[target] = rows[target] ^ rows[a]
        elif function == 15:
            rows[target] = rows[target] ^ {0}
        elif function == 1:
            assert a < 16 and b < 16 and target >= 16
            assert all(term.bit_count() <= 1 for term in rows[a] | rows[b])
            product = set()
            for left in rows[a]:
                for right in rows[b]:
                    term = left | right
                    if term in product:
                        product.remove(term)
                    else:
                        product.add(term)
            rows[target] = rows[target] ^ product
        else:
            raise AssertionError(f'Unsupported gate {function}')
    return rows


actual = exact_outputs(gates)
expected = exact_outputs(solution)
assert actual == expected, 'Exact polynomial equivalence failed'


def write_circuit(name, circuit):
    payload = '{\n  "wire_count": 32,\n  "gate_count": ' + str(len(circuit)) + ',\n  "gates": [\n'
    payload += ',\n'.join('    ' + json.dumps(gate) for gate in circuit)
    payload += '\n  ]\n}\n'
    (OUT / f'{name}.json').write_text(payload)


write_circuit(NAME, gates)
write_circuit(NAME + '-solved', solution)
proof = {
    'seed': SEED,
    'wire_count': WIRES,
    'gate_count': len(gates),
    'size_multiple_of_tangled_not': 20,
    'recursive_depth_per_tree': DEPTH,
    'affine_conjugation_nodes_per_tree_pair': len(node_lengths),
    'expanded_affine_conjugations': 2 * len(node_lengths),
    'nonlinear_gates': sum(gate[3] == 1 for gate in gates),
    'solution_gate_count': len(solution),
    'optimality': 'Four output wires change; each gate changes only one target, so at least four gates are necessary.',
    'construction': 'F G F G followed by the solution. F and G are recursively affine-conjugated shears: lower 16 wires unchanged, upper wires XOR functions of the lower half. All such shears commute and square to identity.',
    'verification': 'Exact algebraic normal forms for every output, valid for all 2^32 inputs; no random sampling.',
    'output_monomials_hex': [[hex(term) for term in sorted(row)] for row in actual],
    'circuit_sha256': hashlib.sha256((OUT / f'{NAME}.json').read_bytes()).hexdigest(),
}
(OUT / f'{NAME}-proof.json').write_text(json.dumps(proof, indent=2) + '\n')
print(f'Generated {len(gates):,} gates with recursive affine conjugations; exactly equivalent to an optimal {len(solution)}-gate solution')
