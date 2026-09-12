import { entitySpec } from '@montionugera/entity-spec';
import { UserFixture } from '@montionugera/entity-spec/testing';
import { openapiDocument } from './document';

const doc = openapiDocument([entitySpec(UserFixture)], '1.2.0') as Record<string, any>;

describe('openapiDocument', () => {
  it('declares OpenAPI 3.1 and mirrors the contract version', () => {
    expect(doc.openapi).toBe('3.1.0');
    expect(doc.info).toEqual({ title: 'server-decorator API', version: '1.2.0' });
  });

  it('collects tags and the shared problem schemas', () => {
    expect(doc.tags).toEqual([{ name: 'identity' }]);
    expect(doc.components.schemas).toHaveProperty('Problem');
    expect(doc.components.schemas).toHaveProperty('ValidationProblem');
  });

  it('carries the entity description onto its routes', () => {
    expect(doc.paths['/users'].get.tags).toEqual(['identity']);
  });
});
