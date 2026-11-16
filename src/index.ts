import { logTimed } from './utils.js'
import { initializeRainbowTables } from './rainbow-portfolio.js'
import { join, parse } from 'path'
import { splitTaskAndRun } from './processing.js'
import { loadJob, logJob } from './job.js'

const run = async (pathToFileWithoutExt: string, original: string) => {
	const circuits = loadJob(pathToFileWithoutExt, original)
	logJob(pathToFileWithoutExt, original, circuits)
	logTimed('Initializing rainbow table portfolio...')
	await initializeRainbowTables()
	try {
		await splitTaskAndRun(pathToFileWithoutExt, original, circuits)
	} catch(e: unknown) {
		console.error(e)
	}
}
if (process.argv.length !== 4) throw new Error('Usage: npm run optimize -- working.json original.json')
const workingFile = parse(process.argv[2])
const originalFile = parse(process.argv[3])
run(join(workingFile.dir, workingFile.name), join(originalFile.dir, originalFile.name))
