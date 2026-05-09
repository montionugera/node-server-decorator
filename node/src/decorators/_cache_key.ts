// _cache_key.ts — deterministic cache-key algorithm shared with Python.
// Spec: contracts/rules/cache-key.md (v1.0.0). Parity test fixtures live at
// contracts/fixtures/cache-key.examples.json.

import { createHash } from 'crypto'

export const MAX_KEY_BYTES = 250

/**
 * Stable JSON serializer: sorts object keys recursively. Mirrors Python's
 * `json.dumps(x, sort_keys=True, default=str, separators=(",", ":"))`.
 */
function stableStringify(x: unknown): string {
  if (x === null) return 'null'
  if (typeof x === 'number' || typeof x === 'boolean') return JSON.stringify(x)
  if (typeof x === 'string') return JSON.stringify(x)
  if (Array.isArray(x)) {
    return '[' + x.map(stableStringify).join(',') + ']'
  }
  if (typeof x === 'object') {
    const keys = Object.keys(x as Record<string, unknown>).sort()
    const parts = keys.map(
      (k) => JSON.stringify(k) + ':' + stableStringify((x as Record<string, unknown>)[k]),
    )
    return '{' + parts.join(',') + '}'
  }
  // Anything else (function, undefined, BigInt, etc.) — match Python `default=str`.
  return JSON.stringify(String(x))
}

function utf8ByteLen(s: string): number {
  return Buffer.byteLength(s, 'utf8')
}

export function buildCacheKey(
  qualname: string,
  args: unknown[],
  kwargs: Record<string, unknown> = {},
): string {
  const argPieces: string[] = args.map(stableStringify)
  const kwargKeys = Object.keys(kwargs).sort()
  for (const k of kwargKeys) {
    argPieces.push(`${k}=${stableStringify(kwargs[k])}`)
  }
  const argRepr = argPieces.join(',')
  const raw = `${qualname}(${argRepr})`
  if (utf8ByteLen(raw) <= MAX_KEY_BYTES) {
    return raw
  }
  const digest = createHash('sha256').update(raw, 'utf8').digest('hex')
  return `${qualname}(sha256:${digest})`
}
