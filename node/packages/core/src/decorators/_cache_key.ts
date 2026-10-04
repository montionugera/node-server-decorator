// _cache_key.ts — deterministic cache-key algorithm shared with Python.
// Spec: contracts/rules/cache-key.md (v1.0.0). Parity test fixtures live at
// contracts/fixtures/cache-key.examples.json.

import { createHash } from 'crypto'

export const MAX_KEY_BYTES = 250

function throwNonFinite(value: unknown): never {
  throw new TypeError(`cache key: non-finite number (${String(value)}) is not JSON-serializable`)
}

// Code-point order (what Python `sort_keys` and Go use); the default sort compares UTF-16 units.
function compareCodePoints(a: string, b: string): number {
  if (a === b) return 0
  const lenA = a.length
  const lenB = b.length
  let i = 0
  let j = 0
  while (i < lenA && j < lenB) {
    const cpA = a.codePointAt(i)!
    const cpB = b.codePointAt(j)!
    if (cpA !== cpB) {
      return cpA < cpB ? -1 : 1
    }
    i += cpA > 0xffff ? 2 : 1
    j += cpB > 0xffff ? 2 : 1
  }
  return lenA - lenB
}

/**
 * Stable JSON serializer: sorts object keys recursively. Mirrors Python's
 * `json.dumps(x, sort_keys=True, default=str, separators=(",", ":"))`.
 */
function stableStringify(x: unknown): string {
  if (x === null) return 'null'
  if (typeof x === 'number') {
    // JSON.stringify(NaN|Infinity) is "null", which would collide with a real null arg.
    if (!Number.isFinite(x)) {
      throwNonFinite(x)
    }
    return JSON.stringify(x)
  }
  if (typeof x === 'boolean') return JSON.stringify(x)
  if (typeof x === 'string') return JSON.stringify(x)
  if (Array.isArray(x)) {
    return '[' + x.map(stableStringify).join(',') + ']'
  }
  if (typeof x === 'object') {
    if (x instanceof Number && !Number.isFinite(x.valueOf())) {
      throwNonFinite(x)
    }
    // Keyless built-ins would otherwise all serialise as `{}` and collide.
    // toISOString throws RangeError on an invalid Date (toJSON would yield null).
    if (x instanceof Date) return JSON.stringify(x.toISOString())
    if (x instanceof Map) {
      const entries: [string, unknown][] = []
      for (const [k, v] of x) {
        const num = k instanceof Number ? k.valueOf() : k
        if (typeof num === 'number' && !Number.isFinite(num)) {
          throwNonFinite(k)
        }
        entries.push([String(k), v])
      }
      entries.sort(([k1], [k2]) => compareCodePoints(k1, k2))
      const parts = entries.map(([k, v]) => JSON.stringify(k) + ':' + stableStringify(v))
      return '{' + parts.join(',') + '}'
    }
    if (x instanceof Set) {
      return '[' + Array.from(x, stableStringify).sort(compareCodePoints).join(',') + ']'
    }
    if (typeof (x as { toJSON?: unknown }).toJSON === 'function') {
      return stableStringify((x as { toJSON: () => unknown }).toJSON())
    }
    const keys = Object.keys(x as Record<string, unknown>).sort(compareCodePoints)
    const proto = Object.getPrototypeOf(x)
    if (keys.length === 0 && proto !== Object.prototype && proto !== null) {
      // Keyless non-plain object (RegExp, Error, ...) — match Python `default=str`.
      return JSON.stringify(String(x))
    }
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
  const kwargKeys = Object.keys(kwargs).sort(compareCodePoints)
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
