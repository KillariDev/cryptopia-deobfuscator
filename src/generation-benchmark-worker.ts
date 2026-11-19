import { defaultConfigPath, readConfigDocument } from './config-document.js'
import { writeFileSync, statSync, readdirSync } from 'fs'
import { join } from 'path'
import { pathToFileURL } from 'url'
import { createHash } from 'crypto'
// Run as a fresh process so imports, SQLite and worker pools cannot leak between trials.
const [root, directory, wiresText, gatesText, workersText, output, settingsSource] = process.argv.slice(2)
const wires = Number(wiresText), gates = Number(gatesText), workers = Number(workersText)
const settings = readConfigDocument(settingsSource ?? defaultConfigPath(root))
settings.files ??= {}
settings.database ??= {}
settings.logging ??= {}
settings.files.databaseDirectory = directory
settings.files.dataDirectory = directory
settings.database.generationWorkers = workers
settings.logging.verbose = false
const settingsPath = join(directory, 'settings.json')
writeFileSync(settingsPath, JSON.stringify(settings))
process.env.OPTIMIZER_CONFIG = settingsPath
const moduleAt = (name: string) => pathToFileURL(join(root, 'dist', `${name}.js`)).href
const { createRainbowTable, closeRainbowTable, databaseFilename } = await import(moduleAt('rainbowtable'))
const { decodeGates, circuitState } = await import(moduleAt('semantic'))
const { stateIdentifier } = await import(moduleAt('generation-expansion'))
const { getVars } = await import(moduleAt('utils'))
let peakBytes = 0
const path = databaseFilename(wires, gates)
const fileSize = (name: string) => { try { return statSync(name).size } catch { return 0 } }
const storageBytes = (root: string): number => {
	let total = 0
	try { for (const entry of readdirSync(root, { withFileTypes: true })) {
		const name = join(root, entry.name)
		total += entry.isDirectory() ? storageBytes(name) : /\.(db|db-wal|db-journal|db-shm)$/.test(name) ? fileSize(name) : 0
	} } catch { /* Scratch files may disappear between samples. */ }
	return total
}
const sample = () => { peakBytes = Math.max(peakBytes, storageBytes(directory)) }
const timer = setInterval(sample, 25), cpuStarted = process.cpuUsage(), started = performance.now()
try {
	let operations: unknown, profile: unknown, staging: unknown
	const db = await createRainbowTable(wires, gates, (value: unknown, activity: { operations?: unknown, candidateCacheChecked?: number, candidateCacheSkipped?: number, candidateCacheBytes?: number, stagingQueuePeakBatches?: number } | undefined) => { profile = value; operations = activity?.operations; staging = { checked: activity?.candidateCacheChecked ?? 0, skipped: activity?.candidateCacheSkipped ?? 0, cacheBytes: activity?.candidateCacheBytes ?? 0, peakBatches: activity?.stagingQueuePeakBatches ?? 0 } }), generationMs = performance.now() - started, cpu = process.cpuUsage(cpuStarted)
	sample()
	let rows = 0
	const hash = createHash('sha256')
	await new Promise<void>((resolve, reject) => db.each('SELECT ioIdentifier,replacerGates FROM InputOutputReplacers ORDER BY ioIdentifier', (error: Error | null, row: { ioIdentifier: Buffer, replacerGates: Buffer }) => {
		if (error) { reject(error); return }
		try {
			const sequence = decodeGates(row.replacerGates)
			if (stateIdentifier(circuitState(sequence, wires), wires) !== row.ioIdentifier.toString('hex')) throw new Error('Generated replacement has incorrect semantics')
			const variables = sequence.flatMap(getVars)
			hash.update(row.ioIdentifier); hash.update(`:${sequence.length},${new Set(variables).size},${variables.length};`); rows++
		} catch (error) { reject(error) }
	}, (error: Error | null) => error ? reject(error) : resolve()))
	await closeRainbowTable(db); sample()
	writeFileSync(output, JSON.stringify({ wires, gates, workers, generationMs, operations, profile, staging, cpuMs: (cpu.user + cpu.system) / 1000, rows, semanticCostDigest: hash.digest('hex'), peakDatabaseBytes: peakBytes, storageMeasurement: '25ms sampled main and scratch database/WAL/journal/SHM bytes; may miss transient peaks', finalFileBytes: fileSize(path), peakRssBytes: process.resourceUsage().maxRSS * 1024, settings, validation: 'all-replacements-exhaustive' }))
} finally { clearInterval(timer) }
