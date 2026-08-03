import { canonicalJson } from './canonical';

describe('canonicalJson', () => {
  it('sorts keys at every level, no whitespace', () => {
    expect(canonicalJson({ b: 1, a: { d: [2, 1], c: 'x' } }))
      .toBe('{"a":{"c":"x","d":[2,1]},"b":1}');
  });
  it('drops undefined values but keeps null', () => {
    expect(canonicalJson({ a: undefined, b: null })).toBe('{"b":null}');
  });
  it('does not escape non-ASCII', () => {
    expect(canonicalJson({ a: 'ราคา' })).toBe('{"a":"ราคา"}');
  });

  it('sorts keys by codepoint order, matching Python sorted()/json.dumps (not UTF-16 code-unit order)', () => {
    // '￿' (U+FFFF, BMP) vs '\u{10000}' (astral plane, surrogate pair U+D800 U+DC00).
    // UTF-16 code-unit order would put the astral key first (0xD800 < 0xFFFF).
    // Codepoint/byte order puts '￿' first (0xFFFF < 0x10000).
    const key1 = '￿';
    const key2 = '\u{10000}';
    expect(canonicalJson({ [key2]: 2, [key1]: 1 })).toBe(
      `{"${key1}":1,"${key2}":2}`,
    );
  });

  it('serializes undefined array elements as null, matching JSON.stringify semantics', () => {
    expect(canonicalJson([undefined, 1])).toBe('[null,1]');
  });

  it('throws TypeError when serializing undefined at the top level', () => {
    expect(() => canonicalJson(undefined)).toThrow(TypeError);
    expect(() => canonicalJson(undefined)).toThrow(
      'canonicalJson: cannot serialize undefined',
    );
  });
});
