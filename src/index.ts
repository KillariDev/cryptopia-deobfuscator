import { logTimed } from './utils.js'
import { createRainbowTable, RAINBOW_TABLE_GATES, RAINBOW_TABLE_WIRES } from './rainbowtable.js'
import { join, parse } from 'path'
import { splitTaskAndRun } from './processing.js'

const run = async (pathToFileWithoutExt: string, original: string) => {
	logTimed(`Started to run job ${ pathToFileWithoutExt }`)
	await createRainbowTable(RAINBOW_TABLE_WIRES, RAINBOW_TABLE_GATES)
	try {
		await splitTaskAndRun(pathToFileWithoutExt, original)
	} catch(e: unknown) {
		console.error(e)
	}
}
if (process.argv.length !== 4) throw new Error('filename missing')
const workingFile = parse(process.argv[2])
const originalFile = parse(process.argv[3])
run(join(workingFile.dir, workingFile.name), join(originalFile.dir, originalFile.name))
