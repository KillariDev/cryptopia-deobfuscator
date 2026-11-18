/** A pending Promise alone does not keep Node alive. Diagnose startup/shutdown
 * paths that lose their last event-loop handle instead of exiting successfully. */
export class RunLifecycle {
	private phase = 'starting optimizer'
	setPhase = (phase: string) => { this.phase = phase }
	async run(work: () => Promise<void>) {
		let finished = false
		const unfinished = () => {
			if (finished) return
			console.error(`Optimizer stopped unexpectedly while ${this.phase}: pending work remained but no active event-loop handles were available.`)
			process.exitCode = 1
		}
		process.once('beforeExit', unfinished)
		try { await work() }
		finally { finished = true; process.removeListener('beforeExit', unfinished) }
	}
}
