import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { EntitySpec } from '@montionugera/entity-spec';
import { openapiDocument } from './document';

const cases = JSON.parse(
  readFileSync(join(__dirname, '../../../../contracts/fixtures/entity-spec.cases.json'), 'utf8'),
) as { openapi?: Array<{ name: string; spec: EntitySpec; expect: Record<string, unknown> }> };

// RFC 6901 JSON Pointer. Path keys in an OpenAPI document contain '/' ("/users/{id}"), so a
// naive split on '/' cannot address them — segments escape '/' as '~1' and '~' as '~0'.
// gen_openapi's Python runner resolves pointers identically; keep the two in step.
function resolve(doc: unknown, pointer: string): unknown {
  let node: unknown = doc;
  for (const raw of pointer.split('/').slice(1)) {
    if (node === null || node === undefined) return null;
    const key = raw.replace(/~1/g, '/').replace(/~0/g, '~');
    node = Array.isArray(node)
      ? node[Number(key)]
      : (node as Record<string, unknown>)[key];
  }
  // A JSON expectation cannot express `undefined`, so an absent member reads as null in both
  // languages — that is how "this key must not be emitted" is asserted.
  return node === undefined ? null : node;
}

describe('entity-spec.cases.json — openapi', () => {
  for (const c of cases.openapi ?? []) {
    it(c.name, () => {
      const doc = openapiDocument([c.spec], '1.2.0');
      for (const [pointer, expected] of Object.entries(c.expect)) {
        expect({ pointer, actual: resolve(doc, pointer) }).toEqual({ pointer, actual: expected });
      }
    });
  }

  it('runs at least one case', () => {
    expect((cases.openapi ?? []).length).toBeGreaterThan(0);
  });
});
