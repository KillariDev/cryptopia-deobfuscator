/** Repeatable benchmark streams; production randomness is unchanged. */
export const seededRandom = (seed: number) => {
	let state = seed >>> 0
	return () => { state = (Math.imul(state, 1664525) + 1013904223) >>> 0; return state / 4294967296 }
}
