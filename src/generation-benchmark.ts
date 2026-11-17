import { mkdtempSync, rmSync, mkdirSync, readFileSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join, resolve, dirname } from 'path'
import { fileURLToPath } from 'url'
import { createHash } from 'crypto'
import { spawn, execFileSync } from 'child_process'
import { config, configPath } from './config.js'

const smoke = process.argv.includes('--smoke')
const args = process.argv.slice(2).filter(arg => arg !== '--smoke')
if (args.length && (args.length !== 2 || args[0] !== '--reference')) throw new Error('Usage: npm run benchmark:generation -- [--smoke] [--reference /path/to/compiled/reference/repository]')
const currentRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const currentVariants: { name: string, root: string, append?: boolean }[] = config.benchmark.generationStagingComparison
	? [{ name: 'indexed', root: currentRoot, append: false }, { name: 'append', root: currentRoot, append: true }]
	: [{ name: 'current', root: currentRoot }]
const variants = args.length ? [{ name: 'reference', root: resolve(args[1]) }, ...currentVariants] : currentVariants
const temporary = mkdtempSync(join(tmpdir(), 'rainbow-benchmark-'))
const results: Record<string, any>[] = [], digests = new Map<string, string>()
const output = resolve(config.files.dataDirectory, smoke ? 'generation-benchmark-smoke.json' : config.benchmark.generationOutputName)
mkdirSync(dirname(output), { recursive: true })
const revision = (root: string) => { try { return execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim() } catch { try { return readFileSync(join(root, '.generation-reference-revision'), 'utf8').trim() } catch { return null } } }
const runtimeFingerprint = (root: string) => {
	const hash = createHash('sha256')
	for (const file of ['generation-merge', 'generation-staging', 'generation-dedup', 'generation-finalize', 'disk-generation', 'generation-expansion', 'generation-storage', 'generation-pipeline', 'generation-pool', 'generation-progress', 'rainbowtable', 'semantic', 'sql', 'config']) {
		try { hash.update(file); hash.update(readFileSync(join(root, 'dist', `${file}.js`))) } catch { hash.update('absent') }
	}
	return hash.digest('hex')
}
const dirty = (root: string) => { try { return Boolean(execFileSync('git', ['status', '--porcelain'], { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim()) } catch { return null } }
const revisions = variants.map(variant => ({ ...variant, revision: revision(variant.root), workingTreeDirty: dirty(variant.root), runtimeSha256: runtimeFingerprint(variant.root) }))
try {
	for (const table of smoke ? [{ wires: 2, gates: 2 }, { wires: 2, gates: 3 }] : config.benchmark.generationTables) for (const workers of smoke ? [1, 2] : config.benchmark.workerCounts) for (let repeat = 0; repeat < (smoke ? 1 : config.benchmark.repeats); repeat++) {
		for (const variant of repeat % 2 ? [...variants].reverse() : variants) {
			const directory = mkdtempSync(join(temporary, 'trial-')), report = join(directory, 'result.json')
			let settingsSource = variant.name === 'reference' ? join(variant.root, 'solver.config.json') : configPath
			if (variant.append !== undefined) {
				const settings = structuredClone(config)
				settings.database.generationAppendStaging = variant.append
				settingsSource = join(directory, 'variant-settings.json')
				writeFileSync(settingsSource, JSON.stringify(settings))
			}
			await new Promise<void>((resolveTrial, reject) => {
				const child = spawn(process.execPath, [fileURLToPath(new URL('./generation-benchmark-worker.js', import.meta.url)), variant.root, directory, String(table.wires), String(table.gates), String(workers), report, settingsSource], { stdio: ['ignore', 'ignore', 'inherit'] })
				let timedOut = false
				const timer = setTimeout(() => { timedOut = true; child.kill('SIGKILL') }, config.benchmark.generationTimeoutSeconds * 1000)
				child.once('error', error => { clearTimeout(timer); reject(error) })
				child.once('exit', code => { clearTimeout(timer); code === 0 && !timedOut ? resolveTrial() : reject(new Error(timedOut ? 'Generation benchmark exceeded its timeout' : `Generation benchmark failed (${code})`)) })
			})
			const result = { variant: variant.name, repeat, ...JSON.parse(readFileSync(report, 'utf8')) }, key = `${table.wires}/${table.gates}`
			if (digests.has(key) && digests.get(key) !== result.semanticCostDigest) throw new Error(`Generated coverage/cost regression for ${key}`)
			digests.set(key, result.semanticCostDigest); results.push(result)
			writeFileSync(output, JSON.stringify({ schemaVersion: 1, smoke, node: process.version, platform: process.platform, variants: revisions, results }, null, 2) + '\n')
			console.log(`${variant.name} ${key}, ${workers} workers, repeat ${repeat + 1}: ${(result.generationMs / 1000).toFixed(2)}s; ${result.rows} verified functions`)
			rmSync(directory, { recursive: true, force: true })
		}
	}
	console.log(`Generation benchmark saved to ${output}`)
} finally { rmSync(temporary, { recursive: true, force: true }) }
