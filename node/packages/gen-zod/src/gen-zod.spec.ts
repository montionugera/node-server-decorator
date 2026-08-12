import { readFileSync } from 'fs';
import { join } from 'path';
import { entitySpec } from '@montionugera/entity-spec';
import { UserFixture } from '@montionugera/entity-spec/dist/testing/user-fixture';
import { actionInputSchema, createSchema, updateSchema, readSchema, validationErrorFields } from './index';

interface Case {
  name: string; dto: string; payload: unknown; valid: boolean; errorFields: string[];
}
const { cases } = JSON.parse(readFileSync(
  join(__dirname, '../../../../contracts/fixtures/entity-spec.cases.json'), 'utf8'
)) as { cases: Case[] };

const spec = entitySpec(UserFixture);

function schemaFor(dto: string) {
  if (dto === 'create') return createSchema(spec);
  if (dto === 'update') return updateSchema(spec);
  if (dto === 'read') return readSchema(spec);
  if (dto.startsWith('action:')) return actionInputSchema(spec, dto.slice(7));
  throw new Error(`unknown dto ${dto}`);
}

describe('gen-zod against contract validation cases', () => {
  for (const c of cases) {
    it(c.name, () => {
      const result = schemaFor(c.dto).safeParse(c.payload);
      expect(result.success).toBe(c.valid);
      if (!result.success) {
        const fields = validationErrorFields(result.error);
        expect(fields).toEqual([...c.errorFields].sort());
      }
    });
  }
});
