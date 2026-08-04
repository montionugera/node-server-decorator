import { FieldSpec } from '@montionugera/entity-spec';
import { UUID_PATTERN, URI_PATTERN, zodForField } from './map-field';

// P1 gate-review C3 (shared uuid/uri regexes) + I-c (ref carries string constraints, like str).
// See contracts/rules/entity-spec-validation.md.

describe('format: uuid / uri use the shared regexes, not zod builtins', () => {
  it('rejects a 36-char hex-and-dash string that is not a real UUID shape (C3)', () => {
    const f: FieldSpec = { name: 'id', type: 'str', format: 'uuid' };
    // 36 chars of hex + dashes, but not grouped 8-4-4-4-12 — the old ad-hoc regex
    // r"^[0-9a-fA-F-]{36}$" accepted this; the shared UUID_PATTERN must not.
    expect(zodForField(f).safeParse('aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa').success).toBe(false);
  });

  it('accepts a well-formed UUID (C3)', () => {
    const f: FieldSpec = { name: 'id', type: 'str', format: 'uuid' };
    expect(zodForField(f).safeParse('123e4567-e89b-12d3-a456-426614174000').success).toBe(true);
  });

  it('rejects a non-URI string for format: uri (C3)', () => {
    const f: FieldSpec = { name: 'link', type: 'str', format: 'uri' };
    expect(zodForField(f).safeParse('not a url').success).toBe(false);
  });

  it('accepts a well-formed URI (C3)', () => {
    const f: FieldSpec = { name: 'link', type: 'str', format: 'uri' };
    expect(zodForField(f).safeParse('https://example.com/a').success).toBe(true);
  });

  it('UUID_PATTERN / URI_PATTERN are exported and match the contract regexes', () => {
    expect(UUID_PATTERN.test('123e4567-e89b-12d3-a456-426614174000')).toBe(true);
    expect(URI_PATTERN.test('ftp://x')).toBe(true);
  });
});

describe('ref carries string constraints like str (I-c)', () => {
  it('applies min/max to a ref field', () => {
    const f: FieldSpec = { name: 'ownerId', type: 'ref', ref: 'User', min: 5 };
    expect(zodForField(f).safeParse('ab').success).toBe(false);
    expect(zodForField(f).safeParse('abcdef').success).toBe(true);
  });

  it('applies format: uuid to a ref field', () => {
    const f: FieldSpec = { name: 'ownerId', type: 'ref', ref: 'User', format: 'uuid' };
    expect(zodForField(f).safeParse('zzz').success).toBe(false);
    expect(zodForField(f).safeParse('123e4567-e89b-12d3-a456-426614174000').success).toBe(true);
  });

  it('applies pattern to a ref field', () => {
    const f: FieldSpec = { name: 'ownerId', type: 'ref', ref: 'User', pattern: '^u-' };
    expect(zodForField(f).safeParse('x-1').success).toBe(false);
    expect(zodForField(f).safeParse('u-1').success).toBe(true);
  });
});
