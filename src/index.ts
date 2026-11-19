import { logTimed } from './utils.js'
import { initializeRainbowTables } from './rainbow-portfolio.js'
import { join, parse } from 'path'
import { splitTaskAndRun } from './processing.js'
import { loadJob, logJob } from './job.js'
import { RunLifecycle } from './run-lifecycle.js'
import { memorySnapshot } from './concurrency.js'
import { config } from './config.js'

const lifecycle = new RunLifecycle()

const run = async (pathToFileWithoutExt: string, original: string, startOver: boolean) => {
	await splitTaskAndRun(pathToFileWithoutExt, original, async () => {
		const circuits = loadJob(pathToFileWithoutExt, original, startOver)
		logJob(pathToFileWithoutExt, original, circuits)
		const memory = memorySnapshot(config.workers.memoryBudgetMegabytes)
		logTimed(`Memory: ${Math.round(memory.rss / 1048576)} MB resident; ${Math.round(memory.budget / 1048576)} MB effective budget; Node ${process.versions.node}.`)
		return circuits
	}, lifecycle.setPhase, async () => {
		if (config.search.rainbow) {
			logTimed('Initializing rainbow table portfolio...')
			lifecycle.setPhase('initializing rainbow table portfolio')
			await initializeRainbowTables()
		}
	})
	logTimed('Optimization complete: no gates remain.')
}
const args = process.argv.slice(2)
const startOver = args.includes('--startover')
const files = args.filter(arg => arg !== '--startover')
if (files.length !== 1 || files[0].startsWith('--')) throw new Error('Usage: npm run optimize -- puzzle.json [--startover]')
const originalFile = parse(files[0])
if (originalFile.ext !== '.json') throw new Error('Input must be a .json circuit file')
const original = join(originalFile.dir, originalFile.name)
await lifecycle.run(() => run(original, original, startOver)).catch(error => { console.error(error); process.exitCode = 1 })
