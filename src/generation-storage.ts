/** Packed generation keys use the same bit order as lookup identifiers. */
export function packState(state: Uint8Array, wires: number): Buffer {
	const packed = Buffer.alloc(Math.ceil(state.length * wires / 8))
	for (let i = 0; i < state.length; i++) {
		const bit = i * wires, shift = bit & 7
		packed[bit >>> 3] |= state[i] << shift
		if (shift + wires > 8) packed[(bit >>> 3) + 1] |= state[i] >>> (8 - shift)
	}
	return packed
}
export function unpackState(packed: Uint8Array, wires: number): Uint8Array {
	const count = 2 ** wires, mask = (1 << wires) - 1
	if (packed.length !== Math.ceil(count * wires / 8)) throw new Error('Invalid packed generation state')
	return Uint8Array.from({ length: count }, (_, i) => {
		const bit = i * wires, byte = bit >>> 3, shift = bit & 7
		return ((packed[byte] | (packed[byte + 1] ?? 0) << 8) >>> shift) & mask
	})
}
export const generationSignature = (wires: number, depth: number, catalogHash: string) => `packed-direct-v2:${wires}:${depth}:${catalogHash}`
export const generationLookupSchema = 'CREATE TABLE IF NOT EXISTS InputOutputReplacers(ioIdentifier BLOB PRIMARY KEY,replacerGates BLOB NOT NULL,gateCount INTEGER NOT NULL,wireCount INTEGER NOT NULL,readCount INTEGER NOT NULL) WITHOUT ROWID'
export const usedWires = (mask: number) => { let count = 0; for (; mask; mask &= mask - 1) count++; return count }
