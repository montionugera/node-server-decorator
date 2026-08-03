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
});
