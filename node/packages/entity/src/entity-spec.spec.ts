import { readFileSync } from 'fs';
import { join } from 'path';
// The contract schema declares "$schema": draft/2020-12, which ajv's default
// (draft-07) build does not recognize ("no schema with key or ref ..."), so
// this uses the dedicated 2020-12 build rather than the base `ajv` export.
import Ajv from 'ajv/dist/2020';
import addFormats from 'ajv-formats';
import { entitySpec, entitySpecCanonical } from './index';
import { UserFixture } from './testing/user-fixture';

const CONTRACTS = join(__dirname, '../../../../contracts');

describe('EntitySpec IR', () => {
  it('emits byte-identical canonical JSON to the contract fixture', () => {
    const expected = readFileSync(join(CONTRACTS, 'fixtures/entity-spec.valid-user.json'), 'utf8').trim();
    expect(entitySpecCanonical(UserFixture)).toBe(expected);
  });
  it('validates against the entity-spec JSON schema', () => {
    const schema = JSON.parse(readFileSync(join(CONTRACTS, 'schemas/entity-spec.schema.json'), 'utf8'));
    const ajv = new Ajv({ strict: false });
    addFormats(ajv);
    expect(ajv.validate(schema, entitySpec(UserFixture))).toBe(true);
  });
  it('throws when a class has no @Restful decorator', () => {
    class Naked {}
    expect(() => entitySpec(Naked)).toThrow(/not decorated with @Restful/);
  });
});
