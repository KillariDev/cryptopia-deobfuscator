import { spawn } from 'child_process'
import { fileURLToPath } from 'url'
import { config, configPath } from './config.js'

const args = process.argv.slice(2)
const profile = args[0] === '--profile'
if (profile) args.shift()
const child = spawn(process.execPath, [
	`--max-old-space-size=${config.runtime.heapMegabytes}`,
	...(profile ? ['--prof'] : []),
	fileURLToPath(new URL('./index.js', import.meta.url)),
	...args,
], { stdio: 'inherit', env: { ...process.env, OPTIMIZER_CONFIG: configPath } })
child.on('error', error => { console.error(error); process.exitCode = 1 })
child.on('exit', (code, signal) => {
	if (signal) process.kill(process.pid, signal)
	else process.exitCode = code ?? 1
})
