export interface CircuitData {
	wire_count: number
	gate_count: number
	gates: [number, number, number, number][] //control wire 0, control wire 1, target wire, control function
}

export type Gate = {
	a: number
	b: number
	target: number
	gate_i: number
}

export type InputOutputReplacer = {
	ioIdentifier: string
	replacerGates: Gate[]
}
