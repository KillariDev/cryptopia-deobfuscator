// Standalone comparison. Install the historical Z3 version outside the project:
// npm install --prefix /tmp/cryptopia-z3-benchmark z3-solver@5.4.1
// npx tsc && node benchmarks/synthesis-performance.mjs /tmp/cryptopia-z3-benchmark
import { readFileSync, writeFileSync, mkdtempSync } from 'node:fs'
import { execFileSync, spawnSync } from 'node:child_process'
import { createRequire } from 'node:module'
import { tmpdir, cpus, platform, arch } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL, fileURLToPath } from 'node:url'
import { createHash } from 'node:crypto'
import ts from 'typescript'
import { functionKey } from '../dist/semantic.js'
import { normalizeWindow } from '../dist/search.js'
const root = fileURLToPath(new URL('../', import.meta.url))
const reference = 'e0ac39c'
const requireZ3 = createRequire(join(resolve(process.argv[2] ?? '/tmp/cryptopia-z3-benchmark'), 'package.json'))
const z3Path = requireZ3.resolve('z3-solver')
const temporary = mkdtempSync(join(tmpdir(), 'synthesis-performance-'))
let source = execFileSync('git', ['show', `${reference}:src/smt.ts`], { cwd: root, encoding: 'utf8' })
source = source.replace("'./utils.js'", JSON.stringify(pathToFileURL(join(root, 'dist/utils.js')).href))
source = source.replace("'z3-solver'", JSON.stringify(pathToFileURL(z3Path).href))
source = source.replace('timeoutMs: number):', 'timeoutMs: number, timing: any):')
source = source.replace("const { init, killThreads }", "const startup = performance.now(); const { init, killThreads }")
source = source.replace('const api = await init()', 'const api = await init(); timing.startupMs = performance.now() - startup; const searchStarted = performance.now()')
source = source.replace('const result = await solver.check()', 'const result = await solver.check(); timing.checks = (timing.checks ?? 0) + 1')
source = source.replace('await killThreads(api.em)', 'timing.searchMs = performance.now() - searchStarted; const cleanup = performance.now(); await killThreads(api.em); timing.cleanupMs = performance.now() - cleanup')
const referencePath = join(temporary, 'reference.mjs')
writeFileSync(referencePath, ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2021, module: ts.ModuleKind.ES2022 } }).outputText)
const workerPath = join(temporary, 'worker.mjs')
writeFileSync(workerPath, `
import { synthesizeNative, functionKey } from ${JSON.stringify(pathToFileURL(join(root, 'dist/semantic.js')).href)};
import { synthesizeSMT } from ${JSON.stringify(pathToFileURL(referencePath).href)};
const job = JSON.parse(process.argv[2]);
const timing = {}; const cpu = process.cpuUsage(); const started = performance.now();
const replacement = job.strategy === 'z3' ? await synthesizeSMT(job.gates, job.wires, 3, job.timeoutMs, timing) : synthesizeNative(job.gates, job.wires, 3, job.states, job.timeoutMs);
const elapsedMs = performance.now() - started; const used = process.cpuUsage(cpu);
if (replacement && functionKey(replacement, job.wires) !== functionKey(job.gates, job.wires)) throw Error('Invalid replacement');
console.log(JSON.stringify({elapsedMs, ...timing, cpuMs: (used.user + used.system) / 1000, peakRssMiB: process.resourceUsage().maxRSS / 1024, replacementGates: replacement?.length ?? null}));
`)
let seed = 0x5eed
const random = n => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed % n }
const cases = []
for (const wires of [2, 3, 4]) for (const depth of [1, 2, 3]) {
 const base = Array.from({length: depth}, (_, i) => ({a:(i+1)%wires,b:(i+2)%wires,target:i%wires,gate_i:i===0?3:i===1?15:6}))
 const flip = {a:0,b:0,target:0,gate_i:15}
 cases.push({id:`padded-${wires}w-${depth}g`,group:'known-shorter',wires,gates:[...base,flip,flip]})
}
for (const wires of [2,3,4]) {
 const erase={a:0,b:0,target:0,gate_i:3}, flip={a:0,b:0,target:1,gate_i:15}
 cases.push({id:`non-bijective-${wires}w`,group:'non-bijective',wires,gates:[erase,erase,flip,flip]})
 cases.push({id:`random-${wires}w`,group:'random',wires,gates:Array.from({length:6},()=>({a:random(wires),b:random(wires),target:random(wires),gate_i:random(16)}))})
}
// Distinct real windows within the default three-wire/eight-gate scope.
const inputPath = join(root,'data/obfuscated.json'), inputBytes = readFileSync(inputPath)
const gates = JSON.parse(inputBytes).gates.map(([a,b,target,gate_i])=>({a,b,target,gate_i}))
const keys = new Set()
for (let i=0;i<gates.length-3 && keys.size<8;i++) {
 const normalized = normalizeWindow(gates.slice(i,i+3))
 if(normalized.wires.length>3 || keys.has(normalized.key))continue
 keys.add(normalized.key);cases.push({id:`real-${i}`,group:'real-window',wires:normalized.wires.length,gates:normalized.normalized})
}
// Prefer genuinely multi-gate functions among synthetic targets; retain all inputs
// so results can be rechecked even when the original input file changes.
const report={metadata:{node:process.version,cpu:cpus()[0].model,platform:platform(),arch:arch(),reference,z3Version:'5.4.1',nativeRevision:execFileSync('git',['rev-parse','HEAD'],{cwd:root,encoding:'utf8'}).trim(),inputSha256:createHash('sha256').update(inputBytes).digest('hex'),repeats:3,maximumReplacementGates:3},cases:cases.map(c=>({...c,truthKey:functionKey(c.gates,c.wires)})),results:[],notes:[
 'Sequential fresh child process per trial, alternating strategy order. Import time before the function call is excluded for both; Z3 dynamic import, WASM startup and cleanup are included.',
 'Z3 startup/search/cleanup phases instrument the historical implementation without changing its search. Its timeout begins after initialization; native timeout covers the whole function.',
 'Native uses 2000 retained states by default. native-wide uses 200000 states at the 1000 ms budget to distinguish state-cap effects.',
 'Real windows are not filtered to ordinary-optimizer failures. Synthetic padding supplies known shorter equivalents but some targets simplify further.',
 'Undefined results are not proofs of impossibility. Peak RSS is whole-child high-water memory; CPU time includes helper threads. This is a local fallback microbenchmark, not whole-tool throughput.'
]}
for (const timeoutMs of [100,1000]) for(let repeat=0;repeat<3;repeat++) for(const fixture of cases) {
 const strategies=timeoutMs===100?['native','z3']:['native','z3','native-wide']
 if(repeat%2)strategies.reverse()
 for(const strategy of strategies){
  const states=strategy==='native-wide'?200000:2000
  const child=spawnSync(process.execPath,[workerPath,JSON.stringify({...fixture,strategy,states,timeoutMs})],{encoding:'utf8',timeout:20000,maxBuffer:1024*1024})
  if(child.status!==0)throw Error(`${strategy}/${fixture.id}: ${child.error??child.stderr}`)
  const result=JSON.parse(child.stdout.trim().split('\n').at(-1))
  report.results.push({case:fixture.id,strategy,timeoutMs,states:strategy==='z3'?null:states,repeat,...result})
 }
 writeFileSync(join(root,'benchmarks/synthesis-performance.json'),JSON.stringify(report,null,2)+'\n')
 console.log(`${timeoutMs}ms repeat ${repeat+1}: ${fixture.id}`)
}
const { summarize, chart } = await import('./synthesis-report.mjs')
report.summary = summarize(report)
writeFileSync(join(root,'benchmarks/synthesis-performance.json'), JSON.stringify(report,null,2)+'\n')
writeFileSync(join(root,'benchmarks/synthesis-performance.html'), chart(report))
