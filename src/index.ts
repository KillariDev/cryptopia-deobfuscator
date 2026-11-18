import { logTimed } from './utils.js'
import { initializeRainbowTables } from './rainbow-portfolio.js'
import { join, parse } from 'path'
import { splitTaskAndRun } from './processing.js'
import { loadJob, logJob } from './job.js'

const run = async (pathToFileWithoutExt: string, original: string, startOver: boolean) => {
	const circuits = loadJob(pathToFileWithoutExt, original, startOver)
	logJob(pathToFileWithoutExt, original, circuits)
	logTimed('Initializing rainbow table portfolio...')
	await initializeRainbowTables()
	try {
		await splitTaskAndRun(pathToFileWithoutExt, original, circuits)
	} catch(e: unknown) {
		console.error(e)
	}
}
const args = process.argv.slice(2)
const startOver = args.includes('--startover')
const files = args.filter(arg => arg !== '--startover')
if (files.length !== 1 || files[0].startsWith('--')) throw new Error('Usage: npm run optimize -- puzzle.json [--startover]')
const originalFile = parse(files[0])
if (originalFile.ext !== '.json') throw new Error('Input must be a .json circuit file')
const original = join(originalFile.dir, originalFile.name)
run(original, original, startOver).catch(error => { console.error(error); process.exitCode = 1 })
