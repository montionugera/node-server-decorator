import express from 'express';
import request from 'supertest';
import { EntityHandler, EntitySpec, mountExpressRoutes, validateDto } from './express';

// Regression suite: behaviours contracts/rules/rest-conventions.md requires of every
// route adapter (Node express, Python fastapi, Go net/http + gin).

function makeHandler(): EntityHandler {
  return {
    list: jest.fn(async () => ({ items: [], total: 0 })),
    get: jest.fn(async (id: string) => ({ id })),
    create: jest.fn(async (data: any) => ({ id: '1', ...data })),
    update: jest.fn(async (id: string, data: any) => ({ id, ...data })),
    delete: jest.fn(async () => undefined),
    action: jest.fn(async () => ({ ok: true })),
  } as unknown as EntityHandler;
}

function makeApp(spec: EntitySpec, handler: EntityHandler, options?: any) {
  const app = express();
  app.use(express.json());
  const router = express.Router();
  mountExpressRoutes(router, spec, handler, options);
  app.use(router);
  return app;
}

const securedSpec: EntitySpec = {
  specVersion: '1.2.0',
  entity: 'Member',
  path: '/members',
  ops: ['list', 'get', 'delete'],
  fields: [
    { name: 'id', type: 'str', role: 'id', readonly: true },
    { name: 'name', type: 'str' },
  ],
  actions: [{ name: 'ping' }, { name: 'promote' }],
  security: {
    schemes: [{ name: 'bearerAuth', type: 'http', scheme: 'bearer' }],
    ops: { list: [], delete: ['members:delete'] },
    actions: { ping: [], promote: ['members:admin'] },
  },
} as EntitySpec;

describe('scope authorization: empty scope list means authentication required', () => {
  it('returns 401 for an unauthenticated request to an op declared with []', async () => {
    const handler = makeHandler();
    const extractor = jest.fn(async () => ({ authenticated: false, scopes: [] }));
    const res = await request(makeApp(securedSpec, handler, { authExtractor: extractor })).get(
      '/members'
    );
    expect(res.status).toBe(401);
    expect(extractor).toHaveBeenCalledTimes(1);
    expect(handler.list).not.toHaveBeenCalled();
  });

  it('returns 401 for an unauthenticated request to an action declared with []', async () => {
    const handler = makeHandler();
    const extractor = jest.fn(async () => ({ authenticated: false, scopes: [] }));
    const res = await request(makeApp(securedSpec, handler, { authExtractor: extractor }))
      .post('/members/m1/actions/ping')
      .send({});
    expect(res.status).toBe(401);
    expect(handler.action).not.toHaveBeenCalled();
  });

  it('allows an authenticated request holding no scopes on an op declared with []', async () => {
    const handler = makeHandler();
    const extractor = async () => ({ authenticated: true, scopes: [] });
    const res = await request(makeApp(securedSpec, handler, { authExtractor: extractor })).get(
      '/members'
    );
    expect(res.status).toBe(200);
  });

  it('keeps an op with no security entry public', async () => {
    const handler = makeHandler();
    const extractor = jest.fn(async () => ({ authenticated: false, scopes: [] }));
    const res = await request(makeApp(securedSpec, handler, { authExtractor: extractor })).get(
      '/members/m1'
    );
    expect(res.status).toBe(200);
    expect(extractor).not.toHaveBeenCalled();
  });
});

describe('scope authorization: fails closed when no extractor is supplied', () => {
  it.each([
    ['delete', '/members/m1', 'op with scopes'],
    ['get', '/members', 'op with []'],
  ])('%s %s (%s) returns 401', async (method, path) => {
    const handler = makeHandler();
    const res = await (request(makeApp(securedSpec, handler)) as any)[method](path);
    expect(res.status).toBe(401);
    expect(res.body).toMatchObject({ title: 'Unauthorized', status: 401 });
    expect(handler.delete).not.toHaveBeenCalled();
    expect(handler.list).not.toHaveBeenCalled();
  });

  it('action with scopes returns 401', async () => {
    const handler = makeHandler();
    const res = await request(makeApp(securedSpec, handler))
      .post('/members/m1/actions/promote')
      .send({});
    expect(res.status).toBe(401);
    expect(handler.action).not.toHaveBeenCalled();
  });

  it('an op with no security entry stays public', async () => {
    const handler = makeHandler();
    const res = await request(makeApp(securedSpec, handler)).get('/members/m1');
    expect(res.status).toBe(200);
  });
});

describe('validateDto: nested fields are filtered by the parent include rule', () => {
  const spec: EntitySpec = {
    specVersion: '1.2.0',
    entity: 'Account',
    path: '/accounts',
    ops: ['create', 'update', 'get'],
    fields: [
      { name: 'id', type: 'str', role: 'id', readonly: true },
      {
        name: 'profile',
        type: 'obj',
        fields: [
          { name: 'bio', type: 'str' },
          { name: 'verifiedAt', type: 'datetime', readonly: true },
          { name: 'secret', type: 'str', writeonly: true },
        ],
      },
      {
        name: 'tags',
        type: 'list',
        optional: true,
        item: {
          name: 'item',
          type: 'obj',
          fields: [
            { name: 'label', type: 'str' },
            { name: 'createdAt', type: 'datetime', readonly: true },
          ],
        },
      },
    ],
  } as EntitySpec;

  it('create does not require a nested readonly field', () => {
    expect(validateDto(spec, 'create', { profile: { bio: 'x', secret: 's' } })).toEqual({
      ok: true,
      fields: [],
    });
  });

  it('create rejects a client-supplied nested readonly field as an unknown key', () => {
    const res = validateDto(spec, 'create', {
      profile: { bio: 'x', secret: 's', verifiedAt: '2026-01-01T00:00:00Z' },
    });
    expect(res).toEqual({ ok: false, fields: ['profile.verifiedAt'] });
  });

  it('update applies the same nested rule', () => {
    expect(validateDto(spec, 'update', { profile: { bio: 'x', secret: 's' } }).ok).toBe(true);
    expect(
      validateDto(spec, 'update', {
        profile: { bio: 'x', secret: 's', verifiedAt: '2026-01-01T00:00:00Z' },
      })
    ).toEqual({ ok: false, fields: ['profile.verifiedAt'] });
  });

  it('filters readonly members of objects nested in a list', () => {
    const base = { profile: { bio: 'x', secret: 's' } };
    expect(validateDto(spec, 'create', { ...base, tags: [{ label: 'a' }] }).ok).toBe(true);
    expect(
      validateDto(spec, 'create', {
        ...base,
        tags: [{ label: 'a', createdAt: '2026-01-01T00:00:00Z' }],
      })
    ).toEqual({ ok: false, fields: ['tags.0.createdAt'] });
  });

  it('read excludes nested writeonly fields and keeps nested readonly ones', () => {
    expect(
      validateDto(spec, 'read', {
        id: '1',
        profile: { bio: 'x', verifiedAt: '2026-01-01T00:00:00Z' },
      }).ok
    ).toBe(true);
    expect(
      validateDto(spec, 'read', {
        id: '1',
        profile: { bio: 'x', verifiedAt: '2026-01-01T00:00:00Z', secret: 's' },
      })
    ).toEqual({ ok: false, fields: ['profile.secret'] });
  });
});

describe('validateDto: str min/max count Unicode code points', () => {
  const spec: EntitySpec = {
    specVersion: '1.2.0',
    entity: 'Tag',
    path: '/tags',
    ops: ['create'],
    fields: [{ name: 'name', type: 'str', min: 3, max: 5 }],
  } as EntitySpec;

  it.each([
    ['ascii at max', 'hello', true],
    ['ascii over max', 'hello!', false],
    ['latin-1 at max', 'héllo', true],
    ['thai below min', 'กข', false],
    ['thai at min', 'กขฃ', true],
    ['emoji at max (5 code points, 10 UTF-16 units)', '\u{1F600}'.repeat(5), true],
    ['emoji over max (6 code points)', '\u{1F600}'.repeat(6), false],
    ['emoji below min (2 code points, 4 UTF-16 units)', '\u{1F600}'.repeat(2), false],
  ])('%s', (_label, value, valid) => {
    expect(validateDto(spec, 'create', { name: value }).ok).toBe(valid);
  });
});
