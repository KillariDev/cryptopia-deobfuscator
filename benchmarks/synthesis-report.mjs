import { readFileSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { resolve } from 'node:path'
export function summarize(report) {
 const median = values => values.sort((a,b)=>a-b)[Math.floor(values.length/2)]
 return [100,1000].flatMap(timeoutMs=>['forward-semantic-search','z3','forward-semantic-search-wide'].flatMap(strategy=>{
  const rows=report.results.filter(row=>row.timeoutMs===timeoutMs&&row.strategy===strategy)
  if(!rows.length)return []
  return [{timeoutMs,strategy,cases:report.cases.length,trials:rows.length,solvedCases:new Set(rows.filter(row=>row.replacementGates!==null).map(row=>row.case)).size,successfulTrials:rows.filter(row=>row.replacementGates!==null).length,medianMs:median(rows.map(row=>row.elapsedMs)),medianStartupMs:median(rows.map(row=>row.startupMs??0)),medianSearchMs:median(rows.map(row=>row.searchMs??row.elapsedMs)),medianCleanupMs:median(rows.map(row=>row.cleanupMs??0)),peakRssMiB:Math.max(...rows.map(row=>row.peakRssMiB))}]
 }))
}
export function chart(report) {
 const summary=summarize(report)
 const names={'forward-semantic-search':'Forward semantic search · 2k states',z3:'Z3', 'forward-semantic-search-wide':'Forward semantic search · 200k states'}
 const panels=[100,1000].map(budget=>`<section><h3>${budget} ms search budget</h3>${summary.filter(row=>row.timeoutMs===budget).map(row=>`<div class="row"><div>${names[row.strategy]}</div><div class="bar"><i style="width:${Math.max(1,Math.log10(row.medianMs+1)/Math.log10(2001)*100)}%;background:var(--chart-${row.strategy==='z3'?2:1})"></i></div><strong>${row.medianMs.toFixed(1)} ms</strong><span>${row.solvedCases}/${row.cases} solved</span></div>`).join('')}</section>`).join('')
 return `<!doctype html><html><head><meta charset="utf-8"><style>body{color:var(--foreground);font-family:var(--font-sans);font-size:14px}h2{font-size:19px;margin:4px 0 8px}h3{font-size:15px;margin:18px 0 10px}p{color:var(--muted-foreground);line-height:1.5}section{margin-bottom:16px}.row{display:grid;grid-template-columns:145px minmax(60px,1fr) 80px 80px;align-items:center;gap:8px;margin:12px 0}.bar{height:16px;background:var(--secondary);border-radius:var(--radius);overflow:hidden}.bar i{display:block;height:100%}strong{text-align:right;font-variant-numeric:tabular-nums}span{text-align:right;font-size:12px}small{display:block;color:var(--muted-foreground);line-height:1.5}@media(max-width:450px){.row{grid-template-columns:110px minmax(20px,1fr) 62px 68px;font-size:12px;gap:4px}}</style></head><body><h2>Forward semantic search vs Z3</h2><p>Median time per attempt, including Z3 startup and cleanup.<br>23 circuits · 3 repetitions · sequential fresh processes</p>${panels}<small>Latency bars use a logarithmic scale. Solved = a verified shorter circuit found in at least one repetition. Both results and replacement lengths were consistent across repetitions.<br>Inputs: 15 synthetic cases across 2–4 wires and 8 real three-gate windows; 4-wire cases exceed the default scope. This measures the local fallback, not whole-tool throughput.<br>Z3 startup is excluded from its search budget; forward semantic search setup is included. At 1000 ms, Z3 median phases: startup ${summary.find(row=>row.strategy==='z3'&&row.timeoutMs===1000).medianStartupMs.toFixed(0)} ms, search ${summary.find(row=>row.strategy==='z3'&&row.timeoutMs===1000).medianSearchMs.toFixed(0)} ms, cleanup ${summary.find(row=>row.strategy==='z3'&&row.timeoutMs===1000).medianCleanupMs.toFixed(0)} ms. Phase medians need not sum to the total median.</small></body></html>`
}
if(process.argv[1] && resolve(process.argv[1])===fileURLToPath(import.meta.url)) {
 const input=fileURLToPath(new URL('./synthesis-performance.json',import.meta.url)), report=JSON.parse(readFileSync(input,'utf8'))
 report.summary=summarize(report)
 writeFileSync(input,JSON.stringify(report,null,2)+'\n')
 writeFileSync(fileURLToPath(new URL('./synthesis-performance.html',import.meta.url)),chart(report))
 console.log(JSON.stringify(report.summary,null,2))
}
