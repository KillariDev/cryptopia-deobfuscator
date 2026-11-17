import sqlite3 from 'sqlite3'
import { mkdtempSync, rmSync, mkdirSync, readFileSync, writeFileSync } from 'fs'
import { tmpdir, cpus } from 'os'
import { join, resolve, dirname } from 'path'
import { createHash } from 'crypto'
import { execFileSync } from 'child_process'
import { fileURLToPath } from 'url'
import { config } from './config.js'
import { allSQL, runSQL, insertRows } from './sql.js'
import { StagingWriter, StagingRow, stagingParameterLimit } from './generation-staging.js'
import { generateAllGates, configureGenerationDatabase } from './rainbowtable.js'
import { circuitState, encodeGates } from './semantic.js'
import { getVars } from './utils.js'
import { ExpansionKernel, packParents } from './generation-expansion.js'
import { packState, usedWires } from './generation-storage.js'

const smoke = process.argv.includes('--smoke')
if (process.argv.slice(2).some(arg => arg !== '--smoke')) throw new Error('Usage: npm run benchmark:staging -- [--smoke]')
const count = smoke ? 2000 : config.benchmark.stagingRows, repeats = smoke ? 1 : config.benchmark.repeats
const catalog = [...generateAllGates(4)], kernel = new ExpansionKernel(4, catalog), fixture: StagingRow[] = []
let seed = config.benchmark.seed >>> 0
const random = (max: number) => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed % max }
while (fixture.length < count) {
	const parents = Array.from({ length: Math.max(1, Math.floor(config.database.generationBatchRows / catalog.length)) }, () => {
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
const variants = [
	{ name: 'reference', wide: false, prepared: false, large: false, sort: false },
	{ name: 'prepared-small', wide: false, prepared: true, large: false, sort: false },
	{ name: 'unprepared-large', wide: false, prepared: false, large: true, sort: false },
	{ name: 'prepared-large', wide: false, prepared: true, large: true, sort: false },
	{ name: 'prepared-large-sorted', wide: false, prepared: true, large: true, sort: true },
	{ name: 'prepared-wide', wide: true, prepared: true, large: true, sort: false },
	{ name: 'prepared-wide-sorted', wide: true, prepared: true, large: true, sort: true },
]
const directory = mkdtempSync(join(tmpdir(), 'staging-benchmark-')), results: Record<string, unknown>[] = []
const output = resolve(config.files.dataDirectory, smoke ? 'staging-benchmark-smoke.json' : config.benchmark.stagingOutputName)
let expectedDigest: string | undefined
try {
	for (let repeat = 0; repeat < repeats; repeat++) {
		const ordered = repeat % 2 ? [...variants].reverse() : [...variants], shift = repeat % variants.length
		for (const variant of [...ordered.slice(shift), ...ordered.slice(0, shift)]) {
			const db = new sqlite3.Database(join(directory, `${repeat}-${variant.name}.db`))
			let writer: StagingWriter | undefined
			try {
				await configureGenerationDatabase(db)
				await runSQL(db, 'CREATE TEMP TABLE BuildCandidates(state BLOB NOT NULL,mask INTEGER NOT NULL,reads INTEGER NOT NULL,gates BLOB NOT NULL,wires INTEGER NOT NULL,PRIMARY KEY(state,mask)) WITHOUT ROWID')
				const parameters = await stagingParameterLimit(db, variant.wide ? config.benchmark.stagingWideSqlParameters : variant.large ? config.database.generationSqlParameters : config.database.queryBatchSize)
				if (variant.prepared) writer = await StagingWriter.create(db, { prepared: true, sort: variant.sort, parameterLimit: parameters, cacheEntries: config.database.generationStatementCacheEntries })
				await runSQL(db, 'BEGIN')
				const started = performance.now()
				for (let offset = 0; offset < fixture.length; offset += config.database.generationBatchRows) {
					const batch = fixture.slice(offset, offset + config.database.generationBatchRows)
					if (writer) await writer.write(batch)
					else await insertRows(db, 'INSERT INTO BuildCandidates VALUES ', batch, ' ON CONFLICT(state,mask) DO UPDATE SET reads=excluded.reads,gates=excluded.gates WHERE excluded.reads<BuildCandidates.reads', parameters)
				}
				const stagingMs = performance.now() - started
				await runSQL(db, 'COMMIT')
				const digest = createHash('sha256'); let rows = 0
				await new Promise<void>((resolveRows, reject) => db.each('SELECT state,mask,reads,gates,wires FROM BuildCandidates ORDER BY state,mask', (error: Error | null, row: { state: Buffer, mask: number, reads: number, gates: Buffer, wires: number }) => {
					if (error) { reject(error); return }
					digest.update(JSON.stringify([row.state.toString('hex'), row.mask, row.reads, row.gates.toString('hex'), row.wires])); rows++
				}, (error: Error | null) => error ? reject(error) : resolveRows()))
				const actual = digest.digest('hex')
				if (expectedDigest && expectedDigest !== actual) throw new Error('Staging benchmark changes staged candidates or tie winners')
				expectedDigest = actual
				results.push({ repeat, variant: variant.name, parameters, stagingMs, candidateRows: fixture.length, distinctStateMasks: rows, resultDigest: actual, statementStats: writer?.stats ?? null })
				console.log(`${variant.name}, repeat ${repeat + 1}: ${(stagingMs / 1000).toFixed(3)}s; ${rows} identical staged candidates`)
			} finally {
				try { await writer?.close() } finally { await new Promise<void>((resolveClose, reject) => db.close(error => error ? reject(error) : resolveClose())) }
			}
		}
	}
	mkdirSync(dirname(output), { recursive: true })
	const writerHash = createHash('sha256')
	for (const file of ['generation-staging.js', 'sql.js']) writerHash.update(readFileSync(join(dirname(fileURLToPath(import.meta.url)), file)))
	writeFileSync(output, JSON.stringify({ writerRuntimeSha256: writerHash.digest('hex'), schemaVersion: 1, smoke, revision: execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(), workingTreeDirty: Boolean(execFileSync('git', ['status', '--porcelain'], { encoding: 'utf8' }).trim()), node: process.version, platform: process.platform, cpu: cpus()[0]?.model, settings: config, results, limitations: 'Staging-only realistic four-variable/five-gate candidates, same process/shared host, fresh temporary tables. Setup, fixture generation, commit, validation and statement finalization excluded. Sorting and initial statement preparation included. Not full production throughput or cold-disk trials.' }, null, 2) + '\n')
	console.log(`Staging benchmark saved to ${output}`)
} finally { rmSync(directory, { recursive: true, force: true }) }
