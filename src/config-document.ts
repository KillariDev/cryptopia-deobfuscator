import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { parse, printParseErrorCode, type ParseError } from 'jsonc-parser'

export function defaultConfigPath(root: string) {
	const jsonc = join(root, 'solver.config.jsonc')
	return existsSync(jsonc) ? jsonc : join(root, 'solver.config.json')
}

export function parseConfigDocument(text: string) {
	const errors: ParseError[] = []
	const document = parse(text.replace(/^\uFEFF/, ''), errors, { allowTrailingComma: true })
	if (errors.length) {
		const { error, offset } = errors[0]
		throw new Error(`Invalid solver config at offset ${offset}: ${printParseErrorCode(error)}`)
	}
	if (!document || typeof document !== 'object' || Array.isArray(document)) throw new Error('Solver config must be a JSON object')
	return document as Record<string, Record<string, unknown>>
}

export const readConfigDocument = (path: string) => parseConfigDocument(readFileSync(path, 'utf8'))
