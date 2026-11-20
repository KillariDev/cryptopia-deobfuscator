import assert from 'node:assert/strict'
import { SearchProgress } from './search-progress.js'
import { broadRegions, broadSearch } from './broad-search.js'
import { SolverService } from './solver-worker.js'
import { config } from './config.js'
import { RainbowPortfolio } from './rainbow-portfolio.js'
import { createOptimizerCaches, optimizeSubset } from './processing.js'
import { RoundStrategyPicker } from './strategy-picker.js'
import type { WorkerActivity } from './logging.js'
const progress=new SearchProgress(), gates=Array.from({length:100},(_,target)=>({a:0,b:0,target,gate_i:15}))
progress.reset(gates,()=>broadRegions(gates.length))
assert.equal(progress.next(2)?.slice,100)
progress.reset(structuredClone(gates),()=>broadRegions(gates.length))
assert.equal(progress.next(2)?.slice,50,'resume on an equal but newly cloned checkpoint')
const changed=gates.slice();changed[50]={...changed[50],gate_i:0}
progress.reset(changed,()=>broadRegions(changed.length))
assert.deepEqual(progress.next(2),{start:18,end:82,slice:64},'prioritize changed neighborhood')
progress.reset(gates,()=>broadRegions(gates.length))
assert.equal(progress.next(2)?.slice,25,'retain a recent circuit cursor while searching another version')

const saved = structuredClone(config), tables = new RainbowPortfolio([])
try {
	Object.assign(config.search, { strategyAdaptive: true, subsetMaximum: 3, sliceMaximum: 3, sliceMinimum: 2, rainbow: true })
	const broadInput = gates.slice(0, 8)
	const broadCaches = createOptimizerCaches()
	const scan = async (stop: (activity?: WorkerActivity) => boolean = () => false, caches = broadCaches) => {
		let activity: WorkerActivity | undefined
		await broadSearch(tables, structuredClone(broadInput), 8, caches, 5000, () => stop(activity), (_, update) => { activity = update })
		return activity!
	}
	broadCaches.broadStrategyPicker.beginRound(1, 'block-cancellation')
	assert.equal((await scan()).checks, 4)
	assert.deepEqual(await scan().then(({ checks, broadExhausted }) => ({ checks, broadExhausted })), { checks: 0, broadExhausted: true })
	broadCaches.broadStrategyPicker.beginRound(2, 'factored-synthesis')
	assert.equal((await scan()).checks, 4, 'a different strategy gets independent coverage')
	broadCaches.broadStrategyPicker.beginRound(3, 'block-cancellation')
	assert.equal((await scan()).checks, 0, 'rotation retains the completed scan')
	const interrupted = createOptimizerCaches()
	interrupted.broadStrategyPicker.beginRound(1, 'block-cancellation')
	let stopChecks = 0
	assert.equal((await scan(() => ++stopChecks >= 4, interrupted)).broadExhausted, false)
	assert.equal((await scan(() => false, interrupted)).checks, 4, 'retry the interrupted region and cover the remaining regions')

	const shearCaches = createOptimizerCaches()
	shearCaches.broadStrategyPicker.beginRound(1, 'polynomial-shear-interpolation')
	const stoppedShear = await scan(activity => (activity?.checks ?? 0) >= 5, shearCaches)
	assert.equal(stoppedShear.broadExhausted, false)
	const resumedShear = await scan(() => false, shearCaches)
	assert.equal(resumedShear.broadExhausted, true)
	assert.equal(stoppedShear.checks, 5, 'stop after reaching the exhaustive pass')
	assert.equal(resumedShear.checks + stoppedShear.checks, 28, 'cover all 28 windows across two jobs')

	const localInput = [gates[0], gates[0]]
	const localScan = async (cache: ReturnType<typeof createOptimizerCaches>, stopAfterCheck = false, maxSlice = 2) => {
		const activity: WorkerActivity = { passes: 0, subsets: 0, checks: 0, improvements: 0, stage: 'searching' }
		await optimizeSubset(tables, localInput, cache.ioIdentifierCache, cache.processedGatesCache,
			2, maxSlice, 'heavy', () => stopAfterCheck && activity.checks > 0, activity, () => {},
			cache.testedSubsets, 'truth-table-lookup', undefined, undefined, new RoundStrategyPicker(['truth-table-lookup']), 1)
		return activity.checks
	}
	const local = createOptimizerCaches(0)
	assert.equal(await localScan(local, true), 1)
	assert.equal(await localScan(local), 1, 'a canceled attempt must stay eligible')
	assert.equal(await localScan(local, false, 3), 0, 'reuse a completed slice even with a larger maximum slice')
	assert.equal(await localScan(createOptimizerCaches(1)), 1, 'workers maintain independent attempt caches')
} finally { Object.assign(config, saved) }

const service=new SolverService()
const fixture=new URL('data:text/javascript,'+encodeURIComponent(`import {parentPort} from 'node:worker_threads';let n=0;parentPort.on('message',()=>parentPort.postMessage({result:Array.from({length:++n},()=>({a:0,b:0,target:0,gate_i:15}))}));`))
assert.equal((await service.run(fixture,{},1000,()=>false))?.length,1)
assert.equal((await service.run(fixture,{},1000,()=>false))?.length,2,'reuse the same isolate')
assert.equal(await service.run(fixture,{},1000,()=>true),undefined)
console.log('Search reuse: completed broad scans, interrupted retries, per-worker attempt caches and persistent isolated solver passed')
