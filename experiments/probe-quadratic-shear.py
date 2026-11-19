"""Fit a quadratic shear from black-box evaluations and test on held-out inputs.

Usage: python3 experiments/probe-quadratic-shear.py data/nonlinear-basis-maze-shuffled.json
Pass --reference to compare the fitted transformation with another circuit.
This experiment provides sampled evidence only.
"""
import argparse
from collections import Counter
from itertools import combinations
import json
from pathlib import Path
import random
from time import perf_counter


def coefficients(kind):
    constant = (kind >> 3) & 1
    linear_a = constant ^ ((kind >> 1) & 1)
    linear_b = constant ^ ((kind >> 2) & 1)
    return constant, linear_a, linear_b, constant ^ linear_a ^ linear_b ^ (kind & 1)


def evaluate(gates, inputs, sample_count):
    state = inputs.copy()
    ones = (1 << sample_count) - 1
    for a, b, target, kind in gates:
        constant, linear_a, linear_b, product = coefficients(kind)
        left, right = state[a], state[b]
        state[target] ^= ((ones if constant else 0) ^ (left if linear_a else 0)
                          ^ (right if linear_b else 0) ^ ((left & right) if product else 0))
    return state


def gate_terms(a, b, kind):
    terms = set()
    for enabled, term in zip(coefficients(kind), [(), (a,), (b,), tuple(sorted({a, b}))]):
        if enabled:
            terms.symmetric_difference_update([term])
    return terms


def probe(circuit, split, held_out, seed):
    gates = circuit['gates']
    wires = circuit['wire_count']
    pairs = list(combinations(range(split), 2))
    fitting = [0] + [1 << a for a in range(split)] + [(1 << a) | (1 << b) for a, b in pairs]
    rng = random.Random(seed)
    assignments = fitting + [rng.getrandbits(wires) for _ in range(held_out)]
    inputs = [
        sum(((value >> wire) & 1) << sample for sample, value in enumerate(assignments))
        for wire in range(wires)
    ]
    observed = evaluate(gates, inputs, len(assignments))
    candidate = []
    for target in range(split, wires):
        delta = observed[target] ^ inputs[target]
        constant = delta & 1
        linear = [constant ^ ((delta >> (a + 1)) & 1) for a in range(split)]
        if constant:
            candidate.append([0, 0, target, 15])
        for a, include in enumerate(linear):
            if include:
                candidate.append([a, 0, target, 3])
        for sample, (a, b) in enumerate(pairs, split + 1):
            if constant ^ linear[a] ^ linear[b] ^ ((delta >> sample) & 1):
                candidate.append([a, b, target, 1])

    predicted = evaluate(candidate, inputs, len(assignments))
    mismatch = 0
    for actual, expected in zip(observed, predicted):
        mismatch |= actual ^ expected

    exceptions = Counter()
    for a, b, target, kind in gates:
        terms = gate_terms(a, b, kind)
        if target < split:
            if any(any(control >= split for control in term) for term in terms):
                exceptions['upper control on lower target'] += 1
        elif any(len(term) == 2 and any(control >= split for control in term) for term in terms):
            exceptions['quadratic upper dependence on upper target'] += 1

    return candidate, {
        'input_gates': len(gates),
        'fitted_gates_by_function': dict(Counter(gate[3] for gate in candidate)),
        'fit_inputs': len(fitting),
        'fit_mismatches': (mismatch & ((1 << len(fitting)) - 1)).bit_count(),
        'held_out_inputs': held_out,
        'held_out_mismatches': (mismatch >> len(fitting)).bit_count(),
        'gates_outside_partition': dict(exceptions),
    }


def shear_signature(gates, split):
    terms = set()
    for a, b, target, kind in gates:
        if target < split:
            raise ValueError('Reference writes a lower wire')
        for term in gate_terms(a, b, kind):
            if any(control >= split for control in term):
                raise ValueError('Reference reads an upper wire')
            terms.symmetric_difference_update([(target, term)])
    return terms


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('circuit', type=Path)
    parser.add_argument('--reference', type=Path)
    parser.add_argument('--split', type=int, default=32)
    parser.add_argument('--held-out', type=int, default=4096)
    parser.add_argument('--seed', type=int, default=10217)
    args = parser.parse_args()
    circuit = json.loads(args.circuit.read_text())
    if not 0 < args.split < circuit['wire_count'] or args.held_out < 1:
        parser.error('split must be inside the wire range and held-out must be positive')

    start = perf_counter()
    candidate, report = probe(circuit, args.split, args.held_out, args.seed)
    if args.reference:
        reference = json.loads(args.reference.read_text())
        report['matches_reference_shear'] = (
            circuit['wire_count'] == reference['wire_count']
            and shear_signature(candidate, args.split) == shear_signature(reference['gates'], args.split)
        )
    report['elapsed_seconds'] = round(perf_counter() - start, 3)
    print(json.dumps(report, indent=2))


if __name__ == '__main__':
    main()
