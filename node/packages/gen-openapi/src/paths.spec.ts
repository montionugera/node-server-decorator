import { entitySpec } from '@montionugera/entity-spec';
import { UserFixture } from '@montionugera/entity-spec/testing';
import { openapiPaths } from './paths';

const paths = openapiPaths(entitySpec(UserFixture)) as Record<string, Record<string, any>>;

describe('openapiPaths', () => {
  it('emits the five CRUD routes and the action routes', () => {
    expect(Object.keys(paths).sort()).toEqual([
      '/users', '/users/{id}', '/users/{id}/actions/activate', '/users/{id}/actions/ping',
    ]);
    expect(Object.keys(paths['/users']).sort()).toEqual(['get', 'post']);
    expect(Object.keys(paths['/users/{id}']).sort()).toEqual(['delete', 'get', 'patch']);
  });

  it('uses PATCH for update and never PUT', () => {
    expect(paths['/users/{id}']).not.toHaveProperty('put');
    expect(paths['/users/{id}'].patch.requestBody.content['application/json'].schema)
      .toEqual({ $ref: '#/components/schemas/UserUpdate' });
  });

  it('creates returns 201 referencing the read schema', () => {
    const post = paths['/users'].post;
    expect(Object.keys(post.responses)).toContain('201');
    expect(post.responses['201'].content['application/json'].schema)
      .toEqual({ $ref: '#/components/schemas/UserRead' });
  });

  it('delete returns 204 with no content', () => {
    expect(paths['/users/{id}'].delete.responses['204']).toEqual({ description: 'No Content' });
  });

  it('adds pagination and filterable query parameters to list only', () => {
    const names = paths['/users'].get.parameters.map((p: any) => p.name).sort();
    expect(names).toEqual(['email', 'limit', 'offset', 'status']);
    const status = paths['/users'].get.parameters.find((p: any) => p.name === 'status');
    expect(status.schema.enum).toEqual(['inactive', 'active', 'banned']);
    expect(paths['/users'].post.parameters).toBeUndefined();
  });

  it('attaches security only to declared operations', () => {
    expect(paths['/users'].post.security).toEqual([{ bearerAuth: ['user:write'] }]);
    expect(paths['/users'].get.security).toBeUndefined();
    expect(paths['/users/{id}'].delete.security).toEqual([{ bearerAuth: ['user:admin'] }]);
  });

  it('gives an action with a from-state a 409 response', () => {
    const activate = paths['/users/{id}/actions/activate'].post;
    expect(Object.keys(activate.responses)).toContain('409');
    expect(paths['/users/{id}/actions/ping'].post.responses).not.toHaveProperty('409');
  });
});
