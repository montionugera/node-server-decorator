// Cache-key parity test: load contracts/fixtures/cache-key.examples.json and assert
// buildCacheKey produces the same key as the Python implementation. Ports
// `python/tests/unit/test_cache_key_parity.py`.

import { readFileSync } from 'fs'
import { join } from 'path'
import { buildCacheKey, MAX_KEY_BYTES } from './_cache_key'

interface Example {
  name: string
  qualname: string
  args: unknown[]
  kwargs: Record<string, unknown>
  expected?: string
  expected_prefix?: string
}

const fixturePath = join(__dirname, '..', '..', '..', '..', '..', 'contracts', 'fixtures', 'cache-key.examples.json')
const fixture = JSON.parse(readFileSync(fixturePath, 'utf8')) as { examples: Example[] }

describe('buildCacheKey parity (contracts/fixtures/cache-key.examples.json)', () => {
  it.each(fixture.examples)('$name', (ex) => {
    const actual = buildCacheKey(ex.qualname, ex.args, ex.kwargs)
    if (ex.expected !== undefined) {
      expect(actual).toBe(ex.expected)
    } else if (ex.expected_prefix !== undefined) {
      expect(actual.startsWith(ex.expected_prefix)).toBe(true)
    } else {
      throw new Error(`fixture ${ex.name} has neither expected nor expected_prefix`)
    }
  })

  it('MAX_KEY_BYTES is 250', () => {
    expect(MAX_KEY_BYTES).toBe(250)
  })
})
