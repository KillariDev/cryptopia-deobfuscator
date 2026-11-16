import { config } from './config.js'
import { logTimed } from './utils.js'
import { createRainbowTable, RAINBOW_TABLE_GATES, RAINBOW_TABLE_WIRES } from './rainbowtable.js'
import { join, parse } from 'path'
import { splitTaskAndRun } from './processing.js'
import { loadJob, logJob } from './job.js'

const run = async (pathToFileWithoutExt: string, original: string) => {
	const circuits = loadJob(pathToFileWithoutExt, original)
	logJob(pathToFileWithoutExt, original, circuits)
	logTimed('Initializing rainbow table...')
	const db = await createRainbowTable(RAINBOW_TABLE_WIRES, RAINBOW_TABLE_GATES)
	await new Promise<void>((resolve, reject) => db.close(error => error ? reject(error) : resolve()))
	try {
		await splitTaskAndRun(pathToFileWithoutExt, original, circuits)
	} catch(e: unknown) {
		console.error(e)
	}
}
if (process.argv.length !== 2 && process.argv.length !== 4) throw new Error('Usage: npm run optimize -- [working.json original.json]')
const workingFile = parse(process.argv[2] ?? config.files.working)
const originalFile = parse(process.argv[3] ?? config.files.original)
run(join(workingFile.dir, workingFile.name), join(originalFile.dir, originalFile.name))
