// Keep the candidate batch as the outer loop. An ordinary JOIN can scan the entire
// growing BuildSeen table for every batch instead of probing its primary key.
export const frontierCandidatesSQL = 'SELECT c.state,c.mask,c.reads,c.gates,? FROM BuildCandidates c CROSS JOIN BuildSeen s ON c.state=s.state WHERE s.depth=?'

// Group before either global lookup: masks of the same function share one check.
export const countNewFinalFunctionsSQL = 'SELECT count(*) AS count FROM (SELECT state FROM BuildCandidates GROUP BY state) c WHERE NOT EXISTS (SELECT 1 FROM BuildSeen s WHERE s.state=c.state) AND NOT EXISTS (SELECT 1 FROM InputOutputReplacers o WHERE o.ioIdentifier=c.state)'
