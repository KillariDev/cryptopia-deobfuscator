// reads is uint32 and mask is uint8 (enforced by the expansion kernel). This
// integer score is exact below 2^44 and orders wires, reads, then mask uniquely
// within a function: (state,mask) is unique in both candidate and frontier tables.
export const candidateQualitySQL = 'wires * 1099511627776 + reads * 256 + mask'
const better = 'excluded.gateCount<InputOutputReplacers.gateCount OR (excluded.gateCount=InputOutputReplacers.gateCount AND (excluded.wireCount<InputOutputReplacers.wireCount OR (excluded.wireCount=InputOutputReplacers.wireCount AND excluded.readCount<InputOutputReplacers.readCount)))'
const candidateSource = 'SELECT state,mask,reads,gates,wires FROM BuildCandidates'
const wireCount = Array.from({ length: 8 }, (_, bit) => `((mask >> ${bit}) & 1)`).join('+')
const inputSource = `SELECT state,mask,reads,gates,(${wireCount}) AS wires FROM BuildFrontier INDEXED BY BuildFrontierDepth WHERE depth=? AND id<=?`

export function candidateWinnersSQL(aggregate: boolean, source = candidateSource) {
	if (!aggregate) return `SELECT state,gates,wires,reads FROM (SELECT state,gates,wires,reads,ROW_NUMBER() OVER (PARTITION BY state ORDER BY wires,reads,mask) AS preference FROM (${source})) WHERE preference=1`
	// SQLite's single built-in MIN chooses bare columns from its winning row.
	// Including mask in the score eliminates ties; reference the aggregate so
	// winner selection cannot be optimized away as an unused result expression.
	return `SELECT state,gates,wires,reads FROM (SELECT state,gates,wires,reads,MIN(${candidateQualitySQL}) AS quality FROM (${source}) GROUP BY state) WHERE quality IS NOT NULL`
}
export function candidateMergeSQL(aggregate: boolean, input = false, source = candidateSource) {
	return `INSERT INTO InputOutputReplacers(ioIdentifier,replacerGates,gateCount,wireCount,readCount) SELECT state,gates,?,wires,reads FROM (${candidateWinnersSQL(aggregate, input ? inputSource : source)}) WHERE 1 ON CONFLICT(ioIdentifier) DO UPDATE SET replacerGates=excluded.replacerGates,gateCount=excluded.gateCount,wireCount=excluded.wireCount,readCount=excluded.readCount WHERE ${better}`
}
