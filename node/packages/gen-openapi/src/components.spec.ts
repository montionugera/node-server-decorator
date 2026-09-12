import { entitySpec } from '@montionugera/entity-spec';
import { UserFixture } from '@montionugera/entity-spec/testing';
import { openapiComponents } from './components';

const { schemas, securitySchemes } = openapiComponents(entitySpec(UserFixture));

describe('openapiComponents', () => {
  it('emits the four DTO shapes plus the envelope', () => {
    expect(Object.keys(schemas)).toEqual(expect.arrayContaining([
      'UserCreate', 'UserUpdate', 'UserRead', 'UserActivateInput',
      'UserPingInput', 'UserListResponse',
    ]));
  });

  it('excludes readonly from create and writeonly from read', () => {
    const create = schemas.UserCreate as { properties: Record<string, unknown> };
    const read = schemas.UserRead as { properties: Record<string, unknown> };
    expect(create.properties).not.toHaveProperty('id');
    expect(create.properties).not.toHaveProperty('loginCount');
    expect(create.properties).toHaveProperty('secretNote');
    expect(read.properties).toHaveProperty('id');
    expect(read.properties).not.toHaveProperty('secretNote');
  });

  it('makes every update property optional', () => {
    expect(schemas.UserUpdate).not.toHaveProperty('required');
    const update = schemas.UserUpdate as { properties: Record<string, unknown> };
    const create = schemas.UserCreate as { properties: Record<string, unknown> };
    expect(Object.keys(update.properties)).toEqual(Object.keys(create.properties));
  });

  it('builds an offset envelope referencing the read schema', () => {
    expect(schemas.UserListResponse).toEqual({
      type: 'object',
      properties: {
        items: { type: 'array', items: { $ref: '#/components/schemas/UserRead' } },
        total: { type: 'integer', minimum: 0 },
        limit: { type: 'integer', minimum: 1, maximum: 100 },
        offset: { type: 'integer', minimum: 0 },
      },
      required: ['items', 'total', 'limit', 'offset'],
      additionalProperties: false,
    });
  });

  it('emits an empty strict object for an action with no input', () => {
    expect(schemas.UserPingInput).toEqual({
      type: 'object', properties: {}, additionalProperties: false,
    });
  });

  it('maps declared schemes into securitySchemes', () => {
    expect(securitySchemes.bearerAuth).toEqual({
      type: 'http', scheme: 'bearer', bearerFormat: 'JWT',
    });
  });
});
