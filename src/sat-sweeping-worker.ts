import { parentPort, workerData } from 'node:worker_threads'
import { sweepFactored } from './sat-sweeping-core.js'
import { init } from 'z3-solver'
import { reportSmtDiagnostic } from './smt-solver.js'
let engine: ReturnType<typeof init> | undefined
async function run(data: typeof workerData) {
 const { gates, maximumWires, maximumNodes, maximumEdges, budgetMs } = data
 const deadline = performance.now() + budgetMs
 try {
  const api = workerData.service ? await (engine ??= init({printErr:reportSmtDiagnostic})) : undefined
  const result = await sweepFactored(gates, { maximumWires, maximumNodes, maximumEdges, stopped: () => performance.now() >= deadline }, deadline, undefined, api)
  parentPort!.postMessage({ result })
 } catch (error) { parentPort!.postMessage({ error: String(error) }) }
}
if(workerData.service) parentPort!.on('message', run)
else await run(workerData)
