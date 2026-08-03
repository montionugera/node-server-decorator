import { EntitySpec } from '@montionugera/entity-spec';
import { createSchema, readSchema, validationErrorFields } from './index';

// Reviewer finding: `zodForField`'s `case 'obj'` recursed with
// `strictObject(f.fields ?? [], () => true)`, ignoring the caller's DTO
// include predicate — so a readonly/writeonly nested field leaked into every
// DTO shape regardless of which one was being built. A synthetic spec
// (rather than the shared UserFixture, which has no nested readonly field)
// isolates the bug.
const spec: EntitySpec = {
  specVersion: '1.1.0',
  entity: 'Widget',
  path: 'widgets',
  transports: ['rest'],
  ops: ['create'],
  pagination: 'offset',
  fields: [
    {
      name: 'profile',
      type: 'obj',
      optional: true,
      fields: [
        { name: 'secret', type: 'str', readonly: true },
        { name: 'bio', type: 'str', optional: true },
      ],
    },
  ],
};

describe('nested obj fields respect DTO field filtering', () => {
  it('createSchema rejects a readonly nested field as unknown', () => {
    const result = createSchema(spec).safeParse({ profile: { secret: 'x' } });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(validationErrorFields(result.error)).toEqual(['profile.secret']);
    }
  });

  it('readSchema still includes the readonly nested field', () => {
    const result = readSchema(spec).safeParse({ profile: { secret: 'x' } });
    expect(result.success).toBe(true);
  });
});
