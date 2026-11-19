"""Measure target-specific supports and fit costs without using a solved circuit.

Run without arguments for a synthetic sparse circuit, or pass a circuit path
and --degree. All probe counts exclude the final held-out comparison.
"""
import argparse
from collections import Counter
from itertools import combinations
import json
from math import comb
from pathlib import Path
import random
import runpy
from time import perf_counter

EXPERIMENTS = Path(__file__).resolve().parent
PROBE = runpy.run_path(str(EXPERIMENTS / 'probe-quadratic-shear.py'))
evaluate = PROBE['evaluate']
gate_terms = PROBE['gate_terms']
FIT_LIMIT = 65_536


def structural_support(gates, width):
    inputs = [1 << wire for wire in range(width)]
    delta = [0] * width
    for a, b, target, kind in gates:
        sources = {wire for term in gate_terms(a, b, kind) for wire in term}
        for source in sources:
            delta[target] |= inputs[source] | delta[source]
    return delta


def infer_support(gates, width, backgrounds, rng):
    inputs = [rng.getrandbits(backgrounds) for _ in range(width)]
    output = evaluate(gates, inputs, backgrounds)
    stable = [wire for wire in range(width) if inputs[wire] == output[wire]]
    targets = [wire for wire in range(width) if inputs[wire] != output[wire]]
    support = {wire: [] for wire in targets}
    upper = (1 << backgrounds) - 1
    for control in stable:
        flipped = inputs.copy()
        flipped[control] ^= upper
        perturbed = evaluate(gates, flipped, backgrounds)
        for target in targets:
            if perturbed[target] != output[target]:
                support[target].append(control)
    return stable, support


def probe_count(width, degree):
    return sum(comb(width, size) for size in range(min(degree, width) + 1))


def fit(gates, width, support, degree):
    per_target = {}
    all_masks = {0}
    for target, controls in support.items():
        if probe_count(len(controls), degree) > FIT_LIMIT:
            return None, None
        masks = [sum(1 << wire for wire in subset)
                 for size in range(min(degree, len(controls)) + 1)
                 for subset in combinations(controls, size)]
        all_masks.update(masks)
        if len(all_masks) > FIT_LIMIT:
            return None, None
        per_target[target] = masks

    masks = sorted(all_masks)
    indices = {mask: sample for sample, mask in enumerate(masks)}
    packed = [bytearray((len(masks) + 7) // 8) for _ in range(width)]
    for sample, mask in enumerate(masks):
        while mask:
            bit = mask & -mask
            packed[bit.bit_length() - 1][sample // 8] |= 1 << (sample % 8)
            mask ^= bit
    output = evaluate(gates, [int.from_bytes(row, 'little') for row in packed], len(masks))

    terms = {}
    for target, subset in per_target.items():
        coefficients = {mask: (output[target] >> indices[mask]) & 1 for mask in subset}
        for wire in support[target]:
            bit = 1 << wire
            for mask in subset:
                if mask & bit:
                    coefficients[mask] ^= coefficients[mask ^ bit]
        terms[target] = [mask for mask, coefficient in coefficients.items() if coefficient]
    return terms, len(masks)


def packed_mismatches(gates, width, terms, rng, samples=4096):
    inputs = [rng.getrandbits(samples) for _ in range(width)]
    original = evaluate(gates, inputs, samples)
    expected = inputs.copy()
    for target, masks in terms.items():
        for mask in masks:
            value = (1 << samples) - 1
            while mask:
                bit = mask & -mask
                value &= inputs[bit.bit_length() - 1]
                mask ^= bit
            expected[target] ^= value
    mismatches = 0
    for actual, prediction in zip(original, expected):
        mismatches |= actual ^ prediction
    return mismatches.bit_count()


def profile(gates, width, degree, backgrounds, seed):
    rng = random.Random(seed)
    start = perf_counter()
    stable, support = infer_support(gates, width, backgrounds, rng)
    infer_seconds = perf_counter() - start
    structural = structural_support(gates, width)
    terms, probes = fit(gates, width, support, degree)
    full = probe_count(len(stable), degree)
    used = 0
    if terms is not None:
        for masks in terms.values():
            for mask in masks:
                used |= mask
    return {
        'gates': len(gates),
        'inferred_controls': len(stable),
        'outputs': len(support),
        'structural_support_histogram': dict(sorted(Counter(structural[target].bit_count() for target in support).items())),
        'sampled_support_histogram': dict(sorted(Counter(map(len, support.values())).items())),
        'globally_unused_controls_in_fit': len(stable) - used.bit_count() if terms is not None else None,
        'global_fit_inputs': full,
        'sequential_global_fit_inputs': sum(probe_count(len(stable), d) for d in range(2, degree + 1)),
        'support_discovery_inputs': backgrounds * (1 + len(stable)),
        'per_target_inputs_without_sharing': sum(probe_count(len(controls), degree) for controls in support.values()),
        'unique_per_target_fit_inputs': probes,
        'fitted_terms': sum(map(len, terms.values())) if terms is not None else None,
        'held_out_mismatches_of_4096': packed_mismatches(gates, width, terms, rng) if terms is not None else None,
        'support_discovery_seconds': round(infer_seconds, 3),
        'elapsed_seconds': round(perf_counter() - start, 3),
    }


def wide_sparse_circuit():
    generator = runpy.run_path(str(EXPERIMENTS.parent / 'generators' / 'generate-shuffled-quintic-maze.py'))
    product = generator['flip_product']
    gates = []
    for target in range(48, 64):
        # Each target uses different controls even though the circuit uses all
        # 48 of them. Scratch values are borrowed and restored.
        start = 3 * (target - 48)
        controls = [(start + offset) % 48 for offset in range(6)]
        scratch = [(start + offset) % 48 for offset in range(6, 9)]
        gates.extend(product(controls[:5], target, scratch))
        gates.extend([[controls[4], controls[5], target, 1], [controls[5], 0, target, 3]])
    return gates, 64


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('circuit', nargs='?', type=Path)
    parser.add_argument('--degree', type=int, default=5)
    parser.add_argument('--backgrounds', type=int, default=128)
    parser.add_argument('--seed', type=int, default=9683)
    args = parser.parse_args()
    if args.degree < 1 or args.backgrounds < 1:
        parser.error('degree and backgrounds must be positive')
    if args.circuit:
        circuit = json.loads(args.circuit.read_text())
        gates, width = circuit['gates'], circuit['wire_count']
    else:
        gates, width = wide_sparse_circuit()
    print(json.dumps(profile(gates, width, args.degree, args.backgrounds, args.seed), indent=2))


if __name__ == '__main__':
    main()
