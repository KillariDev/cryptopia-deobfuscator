import { workerData } from 'worker_threads'
import { seededRandom } from './random.js'
if (Number.isSafeInteger(workerData?.solverSeed)) Math.random = seededRandom(workerData.solverSeed)
// Seed before processing.ts constructs its random validation inputs.
await import('./worker.js')
