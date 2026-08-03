// JS string comparison (`<`/`>`) orders by UTF-16 code unit, which splits
// surrogate pairs and sorts astral-plane characters (e.g. U+10000) before BMP
// characters above U+D800 (e.g. U+FFFF). Python's `sorted()`/`json.dumps` (and
// UTF-8 byte order, per entity-spec-canonical.md rule 2) compare by codepoint,
// so we must iterate codepoints (`[...str]`) rather than UTF-16 code units.
function compareCodePoints(a: string, b: string): number {
  const A = [...a];
  const B = [...b];
  const n = Math.min(A.length, B.length);
  for (let i = 0; i < n; i++) {
    const d = A[i].codePointAt(0)! - B[i].codePointAt(0)!;
    if (d !== 0) return d;
  }
  return A.length - B.length;
}

export function canonicalJson(value: unknown): string {
  if (value === undefined) {
    throw new TypeError('canonicalJson: cannot serialize undefined');
  }
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) {
    // Match JSON.stringify semantics: undefined array elements serialize as null.
    return `[${value.map((v) => (v === undefined ? 'null' : canonicalJson(v))).join(',')}]`;
  }
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => compareCodePoints(a, b));
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(',')}}`;
}
