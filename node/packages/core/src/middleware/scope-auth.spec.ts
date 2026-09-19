import { checkScopes, scopeAuthMiddleware } from './scope-auth';

describe('checkScopes', () => {
  it('returns ok: true when all required scopes are held', () => {
    expect(checkScopes(['read', 'write'], ['read', 'write', 'admin'])).toEqual({ ok: true });
    expect(checkScopes([], ['read'])).toEqual({ ok: true });
  });

  it('returns missing scope when not all required are held', () => {
    expect(checkScopes(['read', 'admin'], ['read', 'write'])).toEqual({
      ok: false,
      missing: 'admin',
    });
  });
});

describe('scopeAuthMiddleware', () => {
  const createMockRes = () => {
    const res: any = {
      statusCode: 200,
      headers: {},
      body: '',
      setHeader: jest.fn((k: string, v: string) => {
        res.headers[k] = v;
      }),
      end: jest.fn((data: string) => {
        res.body = data;
      }),
    };
    return res;
  };

  it('allows public endpoint without credentials when no scopes required', async () => {
    const middleware = scopeAuthMiddleware({
      spec: { security: { ops: { getPublic: [] } } },
      operation: 'otherOp',
      extractor: jest.fn(),
    });

    const req = { url: '/public' };
    const res = createMockRes();
    const next = jest.fn();

    await middleware(req, res, next);

    expect(next).toHaveBeenCalled();
    expect(res.statusCode).toBe(200);
  });

  it('returns 401 Problem Details on auth-only endpoint when unauthenticated', async () => {
    const middleware = scopeAuthMiddleware({
      requiredScopes: [],
      extractor: async () => ({ authenticated: false, scopes: [] }),
    });

    const req = { url: '/protected' };
    const res = createMockRes();
    const next = jest.fn();

    await middleware(req, res, next);

    expect(next).not.toHaveBeenCalled();
    expect(res.statusCode).toBe(401);
    expect(res.headers['Content-Type']).toBe('application/problem+json');
    const parsed = JSON.parse(res.body);
    expect(parsed).toEqual({
      type: 'about:blank',
      title: 'Unauthorized',
      status: 401,
      detail: 'authentication required',
      instance: '/protected',
    });
  });

  it('calls next on auth-only endpoint when authenticated', async () => {
    const middleware = scopeAuthMiddleware({
      requiredScopes: [],
      extractor: async () => ({ authenticated: true, scopes: [] }),
    });

    const req = { url: '/protected' };
    const res = createMockRes();
    const next = jest.fn();

    await middleware(req, res, next);

    expect(next).toHaveBeenCalled();
    expect(res.statusCode).toBe(200);
  });

  it('enforces requiredScopes: returns 403 when missing scope', async () => {
    const middleware = scopeAuthMiddleware({
      requiredScopes: ['items:write'],
      extractor: async () => ({ authenticated: true, scopes: ['items:read'] }),
    });

    const req = { originalUrl: '/items/1' };
    const res = createMockRes();
    const next = jest.fn();

    await middleware(req, res, next);

    expect(next).not.toHaveBeenCalled();
    expect(res.statusCode).toBe(403);
    expect(res.headers['Content-Type']).toBe('application/problem+json');
    const parsed = JSON.parse(res.body);
    expect(parsed).toEqual({
      type: 'about:blank',
      title: 'Forbidden',
      status: 403,
      detail: 'missing required scope: items:write',
      instance: '/items/1',
    });
  });

  it('enforces requiredScopes: calls next when all scopes are present', async () => {
    const middleware = scopeAuthMiddleware({
      requiredScopes: ['items:read', 'items:write'],
      extractor: async () => ({
        authenticated: true,
        scopes: ['items:read', 'items:write', 'admin'],
      }),
    });

    const req = { originalUrl: '/items/1' };
    const res = createMockRes();
    const next = jest.fn();

    await middleware(req, res, next);

    expect(next).toHaveBeenCalled();
  });

  it('resolves scopes from spec.security.ops', async () => {
    const spec = {
      security: {
        ops: {
          getUser: ['users:read'],
          deleteUser: ['users:delete'],
        },
      },
    };

    const middleware = scopeAuthMiddleware({
      spec,
      operation: 'deleteUser',
      extractor: async () => ({ authenticated: true, scopes: ['users:read'] }),
    });

    const req = { url: '/users/123' };
    const res = createMockRes();
    const next = jest.fn();

    await middleware(req, res, next);

    expect(next).not.toHaveBeenCalled();
    expect(res.statusCode).toBe(403);
    expect(JSON.parse(res.body).detail).toBe('missing required scope: users:delete');
  });

  it('resolves scopes from spec.security.actions', async () => {
    const spec = {
      security: {
        actions: {
          'order.cancel': ['orders:cancel'],
        },
      },
    };

    const middleware = scopeAuthMiddleware({
      spec,
      action: 'order.cancel',
      extractor: async () => ({ authenticated: true, scopes: ['orders:cancel'] }),
    });

    const req = { url: '/rpc' };
    const res = createMockRes();
    const next = jest.fn();

    await middleware(req, res, next);

    expect(next).toHaveBeenCalled();
  });

  it('bypasses spec check if action is not in spec.security.actions', async () => {
    const spec = {
      security: {
        actions: {
          'order.cancel': ['orders:cancel'],
        },
      },
    };

    const middleware = scopeAuthMiddleware({
      spec,
      action: 'public.ping',
      extractor: jest.fn(),
    });

    const req = { url: '/ping' };
    const res = createMockRes();
    const next = jest.fn();

    await middleware(req, res, next);

    expect(next).toHaveBeenCalled();
  });
});
