import { StagingRow } from './generation-staging.js'
import { generateAllGates } from './rainbowtable.js'
import { circuitState, encodeGates } from './semantic.js'
import { getVars } from './utils.js'
import { ExpansionKernel, packParents } from './generation-expansion.js'
import { packState, usedWires } from './generation-storage.js'
export function makeStagingFixture(count: number, batchRows: number, initialSeed: number): StagingRow[] {
	const catalog = [...generateAllGates(4)], kernel = new ExpansionKernel(4, catalog), fixture: StagingRow[] = []
	let seed = initialSeed >>> 0
	const random = (max: number) => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed % max }
	while (fixture.length < count) {
		const parents = Array.from({ length: Math.max(1, Math.floor(batchRows / catalog.length)) }, () => {
			const sequence = Array.from({ length: 4 }, () => catalog[random(catalog.length)])
			const variables = sequence.flatMap(getVars)
			return { state: circuitState(sequence, 4), mask: variables.reduce((mask, wire) => mask | 1 << wire, 0), reads: variables.length, gates: encodeGates(sequence) }
		})
		const result = kernel.expand({ parents: packParents(parents, kernel.stateBytes), gateStart: 0, gateEnd: catalog.length }), view = new DataView(result.candidates), stride = kernel.stateBytes + 16
		for (let i = 0; i < result.count && fixture.length < count; i++) {
			const offset = i * stride, parent = parents[view.getUint32(offset + kernel.stateBytes, true)], gate = catalog[view.getUint32(offset + kernel.stateBytes + 4, true)], mask = view.getUint32(offset + kernel.stateBytes + 8, true)
			fixture.push([packState(new Uint8Array(result.candidates, offset, kernel.stateBytes), 4), mask, view.getUint32(offset + kernel.stateBytes + 12, true), Buffer.concat([parent.gates, encodeGates([gate])]), usedWires(mask)])
		}
	}
	return fixture
}
