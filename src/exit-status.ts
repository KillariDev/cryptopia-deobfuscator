/** Windows native exceptions can bypass every JavaScript error handler. */
export function optimizerExitMessage(code: number | null) {
	const status = code === null ? undefined : code >>> 0
	const base = `Optimizer process exited with code ${code ?? 'unknown'}${status !== undefined && status > 255 ? ` (0x${status.toString(16).toUpperCase()})` : ''}.`
	if (status === 0xC0000409) return `${base}\nWindows reported a native fail-fast crash. This code alone does not establish memory exhaustion or a stack buffer overrun. Retry with OPTIMIZER_WORKERS=1 to check whether worker concurrency triggers the crash; inspect the Windows Application event log for the faulting module.`
	if (status === 0xC0000017 || status === 0xC000012D) return `${base}\nWindows reported insufficient memory or commit capacity. Reduce OPTIMIZER_WORKERS or free memory before resuming.`
	return base
}
