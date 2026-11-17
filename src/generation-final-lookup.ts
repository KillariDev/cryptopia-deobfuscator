import sqlite3 from 'sqlite3'
import { runSQL } from './sql.js'

export const finalCounterMembershipSQL = 'SELECT 1 FROM main.BuildSeen s WHERE s.state=?'
export const startFinalCounterSQL = 'UPDATE BuildFinalCounter SET active=1,count=0 WHERE id=1'
export const readFinalCounterSQL = 'SELECT count FROM BuildFinalCounter WHERE id=1'
export const stopFinalCounterSQL = 'UPDATE BuildFinalCounter SET active=0 WHERE id=1'

/** Count only genuinely inserted output keys absent from shorter-depth BuildSeen.
 * Existing keys use the normal upsert cost comparison and never fire AFTER INSERT.
 * Pending shorter-depth frontier states may be absent from output: don't count
 * them again when a final-depth candidate temporarily fills their output slot. */
export async function installFinalCounter(db: sqlite3.Database) {
	await runSQL(db, 'CREATE TEMP TABLE IF NOT EXISTS BuildFinalCounter(id INTEGER PRIMARY KEY,active INTEGER NOT NULL,count INTEGER NOT NULL)')
	await runSQL(db, 'INSERT OR REPLACE INTO BuildFinalCounter VALUES(1,0,0)')
	await runSQL(db, `CREATE TEMP TRIGGER IF NOT EXISTS CountFinalOutput AFTER INSERT ON main.InputOutputReplacers
	 WHEN (SELECT active FROM BuildFinalCounter WHERE id=1)=1
	 AND NOT EXISTS(${finalCounterMembershipSQL.replace('?', 'NEW.ioIdentifier')})
	 BEGIN UPDATE BuildFinalCounter SET count=count+1 WHERE id=1; END`)
}
export async function removeFinalCounter(db: sqlite3.Database) {
	await runSQL(db, 'DROP TRIGGER IF EXISTS temp.CountFinalOutput')
	await runSQL(db, 'DROP TABLE IF EXISTS temp.BuildFinalCounter')
}
