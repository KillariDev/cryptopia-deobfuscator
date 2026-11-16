import { config } from './config.js'
import { migrateDatabase } from './migrate.js'
if (process.argv.length !== 4) throw new Error('Usage: npm run migrate-db -- source.db destination.compact.db')
let lastReport = performance.now()
const count = await migrateDatabase(process.argv[2], process.argv[3], config.database.wires, config.database.queryBatchSize, rows => {
	if (performance.now() - lastReport >= config.timing.summarySeconds * 1000) {
		console.log(`Migration: ${rows} entries verified and copied`)
		lastReport = performance.now()
	}
})
console.log(`Migrated and verified ${count} entries. Source database was not modified.`)
