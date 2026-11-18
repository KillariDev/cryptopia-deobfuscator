"""Generate the tangled NOT puzzle/solution in data/ and metadata in proofs/.

Run: python3 generators/generate-tangled-not.py
The 32-wire affine circuit hides a single NOT behind a dense identity network.
Symbolic checks below prove equivalence for all inputs.
"""
import json
import random
from pathlib import Path

root = Path(__file__).resolve().parent.parent
out = root / 'data'
proofs = root / 'proofs'
out.mkdir(exist_ok=True)
proofs.mkdir(exist_ok=True)
rng = random.Random(20261118)
n = 32
matrix = [1 << i for i in range(n)]
gates = []
# A dense change of basis without adjacent involution cancellations.
previous = None
for _ in range(1800):
    while True:
        control, target = rng.sample(range(n), 2)
        if (control, target) != previous:
            break
    previous = control, target
    gates.append([control, 0, target, 3])
    matrix[target] ^= matrix[control]

# Reduce the resulting matrix independently instead of reversing the gate word.
# Each row XOR is a CNOT; three XORs implement a row swap.
def xor_row(control, target):
    matrix[target] ^= matrix[control]
    gates.append([control, 0, target, 3])

for column in range(n):
    pivot = next(row for row in range(column, n) if matrix[row] & (1 << column))
    if pivot != column:
        xor_row(pivot, column)
        xor_row(column, pivot)
        xor_row(pivot, column)
    for row in range(n):
        if row != column and matrix[row] & (1 << column):
            xor_row(column, row)
assert matrix == [1 << i for i in range(n)]
# Hide an actual nonidentity function behind the identity network.
gates.append([0, 0, 0, 15])
solution = [[0, 0, 0, 15]]

# Independent exact symbolic simulation of affine forms, including constant bit.
forms = [1 << i for i in range(n)]
for a, b, target, gate in gates:
    if gate == 3:
        forms[target] ^= forms[a]
    elif gate == 15:
        forms[target] ^= 1 << n
    else:
        raise AssertionError('Unexpected non-affine gate')
assert forms == [(1 << i) ^ ((1 << n) if i == 0 else 0) for i in range(n)]
for name, circuit in [('tangled-not', gates), ('tangled-not-solved', solution)]:
    (out / f'{name}.json').write_text(json.dumps({'wire_count': n, 'gate_count': len(circuit), 'gates': circuit}, indent=2) + '\n')
(proofs / 'tangled-not-proof.json').write_text(json.dumps({'seed': 20261118, 'wire_count': n, 'obfuscated_gates': len(gates), 'optimal_gates': 1, 'function': 'wire 0 is inverted; all other wires are unchanged', 'verification': 'Exact symbolic GF(2) affine forms, valid for all 2^32 inputs', 'output_affine_forms_hex': [hex(v) for v in forms]}, indent=2) + '\n')
print(f'Generated {len(gates)} gates; exactly equivalent to one NOT on wire 0')
