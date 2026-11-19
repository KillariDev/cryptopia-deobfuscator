import type { CircuitData } from './types.js'

export function isWireIndex(index: unknown, wires: number): boolean {
	return typeof index === 'number' && Number.isInteger(index) && index >= 0 && index < wires
}

export function assertCircuitData(value: unknown, maximumWires: number, filename: string): asserts value is CircuitData {
	const circuit = value as Partial<CircuitData> | null
	const wires = circuit?.wire_count
	if (typeof wires !== 'number' || !Number.isSafeInteger(wires) || wires < 1 || wires > maximumWires) {
		throw new Error(`Invalid wire count in ${filename} (expected 1 to ${maximumWires})`)
	}
	if (!Array.isArray(circuit?.gates) || circuit.gate_count !== circuit.gates.length) {
		throw new Error(`Invalid gate count in ${filename}`)
	}
	for (const [index, gate] of circuit.gates.entries()) {
		if (!Array.isArray(gate) || gate.length !== 4 ||
			!isWireIndex(gate[0], wires) || !isWireIndex(gate[1], wires) ||
			!isWireIndex(gate[2], wires) || !isWireIndex(gate[3], 16)) {
			throw new Error(`Invalid gate at index ${index} in ${filename}`)
		}
	}
}
