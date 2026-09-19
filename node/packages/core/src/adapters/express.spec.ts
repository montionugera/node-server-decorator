import express from 'express';
import request from 'supertest';
import {
  EntityHandler,
  EntitySpec,
  NotFoundError,
  PROBLEM_CONTENT_TYPE,
  VALIDATION_PROBLEM_TYPE,
  mountExpressRoutes,
  validateDto,
} from './express';

describe('validateDto', () => {
  const spec: EntitySpec = {
    specVersion: '1.2.0',
    entity: 'User',
    path: '/users',
    ops: ['list', 'get', 'create', 'update', 'delete'],
    fields: [
      { name: 'id', type: 'str', role: 'id', readonly: true },
      { name: 'email', type: 'str', format: 'email' },
      { name: 'age', type: 'int', min: 0, max: 150 },
      { name: 'score', type: 'float', optional: true },
      { name: 'active', type: 'bool' },
      { name: 'role', type: 'enum', enum: ['admin', 'member'] },
      { name: 'createdAt', type: 'datetime', readonly: true },
      { name: 'bio', type: 'str', optional: true, nullable: true },
    ],
    actions: [
      {
        name: 'promote',
        input: [
          { name: 'newRole', type: 'enum', enum: ['admin', 'superadmin'] },
          { name: 'reason', type: 'str', min: 3 },
        ],
      },
    ],
  };

  it('validates create payload successfully', () => {
    const payload = {
      email: 'alex@example.com',
      age: 25,
      active: true,
      role: 'member',
    };
    const { ok, fields } = validateDto(spec, 'create', payload);
    expect(ok).toBe(true);
    expect(fields).toEqual([]);
  });

  it('rejects unknown fields in strict mode', () => {
    const payload = {
      email: 'alex@example.com',
      age: 25,
      active: true,
      role: 'member',
      unknownField: 'bad',
    };
    const { ok, fields } = validateDto(spec, 'create', payload);
    expect(ok).toBe(false);
    expect(fields).toContain('unknownField');
  });

  it('rejects missing required fields', () => {
    const payload = {
      email: 'alex@example.com',
    };
    const { ok, fields } = validateDto(spec, 'create', payload);
    expect(ok).toBe(false);
    expect(fields).toContain('active');
    expect(fields).toContain('age');
    expect(fields).toContain('role');
  });

  it('validates email pattern (WHATWG standard: a@b.c is valid, a@ is invalid)', () => {
    const validPayload = {
      email: 'a@b.c',
      age: 25,
      active: true,
      role: 'member',
    };
    expect(validateDto(spec, 'create', validPayload).ok).toBe(true);

    const invalidPayload = {
      email: 'a@',
      age: 25,
      active: true,
      role: 'member',
    };
    const { ok, fields } = validateDto(spec, 'create', invalidPayload);
    expect(ok).toBe(false);
    expect(fields).toContain('email');
  });

  it('handles update DTO with optional fields', () => {
    const updatePayload = {
      email: 'new@example.com',
    };
    const { ok, fields } = validateDto(spec, 'update', updatePayload);
    expect(ok).toBe(true);
    expect(fields).toEqual([]);
  });

  it('validates action DTO inputs', () => {
    const validAction = {
      newRole: 'admin',
      reason: 'Great performance',
    };
    expect(validateDto(spec, 'action:promote', validAction).ok).toBe(true);

    const invalidAction = {
      newRole: 'guest',
      reason: 'hi', // min: 3
    };
    const { ok, fields } = validateDto(spec, 'action:promote', invalidAction);
    expect(ok).toBe(false);
    expect(fields).toContain('newRole');
    expect(fields).toContain('reason');
  });
});

describe('mountExpressRoutes', () => {
  const userSpec: EntitySpec = {
    specVersion: '1.2.0',
    entity: 'User',
    path: 'users',
    ops: ['list', 'get', 'create', 'update', 'delete'],
    fields: [
      { name: 'id', type: 'str', role: 'id', readonly: true },
      { name: 'name', type: 'str', min: 2 },
      { name: 'email', type: 'str', format: 'email' },
      { name: 'status', type: 'str', filterable: true, optional: true },
    ],
    actions: [
      {
        name: 'deactivate',
        input: [{ name: 'reason', type: 'str', min: 1 }],
      },
    ],
    security: {
      ops: {
        list: ['users:read'],
        get: ['users:read'],
        create: ['users:write'],
        update: ['users:write'],
        delete: ['users:admin'],
      },
      actions: {
        deactivate: ['users:admin'],
      },
    },
  };

  let mockDb: any[];
  let handler: EntityHandler;
  let authContext: { authenticated: boolean; scopes: string[] } = {
    authenticated: true,
    scopes: ['users:read', 'users:write', 'users:admin'],
  };

  const createTestApp = (options?: { extractorOverride?: any }) => {
    mockDb = [
      { id: '1', name: 'Alice', email: 'alice@example.com', status: 'active' },
      { id: '2', name: 'Bob', email: 'bob@example.com', status: 'pending' },
    ];

    handler = {
      list: jest.fn(async ({ limit, offset, filters }) => {
        let filtered = [...mockDb];
        if (filters.status) {
          filtered = filtered.filter((u) => u.status === filters.status);
        }
        const items = filtered.slice(offset, offset + limit);
        return { items, total: filtered.length };
      }),
      get: jest.fn(async (id: string) => {
        const found = mockDb.find((u) => u.id === id);
        if (!found) throw new NotFoundError(`User ${id} not found`);
        return found;
      }),
      create: jest.fn(async (data) => {
        const newUser = { id: String(mockDb.length + 1), ...data };
        mockDb.push(newUser);
        return newUser;
      }),
      update: jest.fn(async (id, data) => {
        const index = mockDb.findIndex((u) => u.id === id);
        if (index === -1) throw new NotFoundError(`User ${id} not found`);
        mockDb[index] = { ...mockDb[index], ...data };
        return mockDb[index];
      }),
      delete: jest.fn(async (id) => {
        const index = mockDb.findIndex((u) => u.id === id);
        if (index === -1) throw new NotFoundError(`User ${id} not found`);
        mockDb.splice(index, 1);
      }),
      action: jest.fn(async (id, actionName, data) => {
        const user = mockDb.find((u) => u.id === id);
        if (!user) throw new NotFoundError(`User ${id} not found`);
        if (actionName === 'deactivate') {
          user.status = 'inactive';
          user.deactivatedReason = data.reason;
          return user;
        }
        throw new Error(`Unsupported action ${actionName}`);
      }),
    };

    const app = express();
    app.use(express.json());
    const router = express.Router();
    mountExpressRoutes(router, userSpec, handler, {
      authExtractor: options?.extractorOverride || (async () => authContext),
    });
    app.use(router);
    return app;
  };

  beforeEach(() => {
    authContext = {
      authenticated: true,
      scopes: ['users:read', 'users:write', 'users:admin'],
    };
  });

  describe('CRUD operations & List Response Envelope', () => {
    it('GET /users returns paginated list envelope with default limit 20 and offset 0', async () => {
      const app = createTestApp();
      const res = await request(app).get('/users');

      expect(res.status).toBe(200);
      expect(res.body).toEqual({
        items: [
          { id: '1', name: 'Alice', email: 'alice@example.com', status: 'active' },
          { id: '2', name: 'Bob', email: 'bob@example.com', status: 'pending' },
        ],
        total: 2,
        limit: 20,
        offset: 0,
      });
      expect(handler.list).toHaveBeenCalledWith({
        limit: 20,
        offset: 0,
        filters: {},
      });
    });

    it('GET /users handles query params for limit, offset, and filterable fields', async () => {
      const app = createTestApp();
      const res = await request(app).get('/users?limit=1&offset=1&status=pending');

      expect(res.status).toBe(200);
      expect(res.body.limit).toBe(1);
      expect(res.body.offset).toBe(1);
      expect(handler.list).toHaveBeenCalledWith({
        limit: 1,
        offset: 1,
        filters: { status: 'pending' },
      });
    });

    it('GET /users/:id returns entity on success', async () => {
      const app = createTestApp();
      const res = await request(app).get('/users/1');

      expect(res.status).toBe(200);
      expect(res.body).toEqual({
        id: '1',
        name: 'Alice',
        email: 'alice@example.com',
        status: 'active',
      });
      expect(handler.get).toHaveBeenCalledWith('1');
    });

    it('GET /users/:id returns 404 Problem Details when entity does not exist', async () => {
      const app = createTestApp();
      const res = await request(app).get('/users/999');

      expect(res.status).toBe(404);
      expect(res.headers['content-type']).toContain(PROBLEM_CONTENT_TYPE);
      expect(res.body).toEqual({
        type: 'about:blank',
        title: 'Not Found',
        status: 404,
        detail: 'User 999 not found',
        instance: '/users/999',
      });
    });

    it('POST /users creates entity and returns 201 on valid payload', async () => {
      const app = createTestApp();
      const res = await request(app)
        .post('/users')
        .send({ name: 'Charlie', email: 'charlie@example.com' });

      expect(res.status).toBe(201);
      expect(res.body).toEqual({
        id: '3',
        name: 'Charlie',
        email: 'charlie@example.com',
      });
      expect(handler.create).toHaveBeenCalledWith({
        name: 'Charlie',
        email: 'charlie@example.com',
      });
    });

    it('POST /users returns 400 Validation Problem on invalid payload', async () => {
      const app = createTestApp();
      const res = await request(app)
        .post('/users')
        .send({ name: 'C', email: 'not-an-email' });

      expect(res.status).toBe(400);
      expect(res.headers['content-type']).toContain(PROBLEM_CONTENT_TYPE);
      expect(res.body.type).toBe(VALIDATION_PROBLEM_TYPE);
      expect(res.body.status).toBe(400);
      expect(res.body.title).toBe('Validation Failed');
      expect(res.body.fields).toContain('email');
      expect(res.body.fields).toContain('name');
      expect(handler.create).not.toHaveBeenCalled();
    });

    it('PATCH /users/:id updates entity and returns 200 on valid partial payload', async () => {
      const app = createTestApp();
      const res = await request(app)
        .patch('/users/1')
        .send({ name: 'Alice Smith' });

      expect(res.status).toBe(200);
      expect(res.body.name).toBe('Alice Smith');
      expect(handler.update).toHaveBeenCalledWith('1', { name: 'Alice Smith' });
    });

    it('DELETE /users/:id deletes entity and returns 204', async () => {
      const app = createTestApp();
      const res = await request(app).delete('/users/1');

      expect(res.status).toBe(204);
      expect(handler.delete).toHaveBeenCalledWith('1');
    });

    it('POST /users/:id/actions/:actionName executes discrete action with validation', async () => {
      const app = createTestApp();
      const res = await request(app)
        .post('/users/1/actions/deactivate')
        .send({ reason: 'Account violated policy' });

      expect(res.status).toBe(200);
      expect(res.body.status).toBe('inactive');
      expect(res.body.deactivatedReason).toBe('Account violated policy');
      expect(handler.action).toHaveBeenCalledWith('1', 'deactivate', {
        reason: 'Account violated policy',
      });
    });
  });

  describe('Declarative Scope Authorization', () => {
    it('returns 401 Problem Details when unauthenticated', async () => {
      authContext = { authenticated: false, scopes: [] };
      const app = createTestApp();
      const res = await request(app).get('/users');

      expect(res.status).toBe(401);
      expect(res.headers['content-type']).toContain(PROBLEM_CONTENT_TYPE);
      expect(res.body).toEqual({
        type: 'about:blank',
        title: 'Unauthorized',
        status: 401,
        detail: 'authentication required',
        instance: '/users',
      });
      expect(handler.list).not.toHaveBeenCalled();
    });

    it('returns 403 Problem Details when missing required scope', async () => {
      // User only has users:read, but delete requires users:admin
      authContext = { authenticated: true, scopes: ['users:read'] };
      const app = createTestApp();
      const res = await request(app).delete('/users/1');

      expect(res.status).toBe(403);
      expect(res.headers['content-type']).toContain(PROBLEM_CONTENT_TYPE);
      expect(res.body).toEqual({
        type: 'about:blank',
        title: 'Forbidden',
        status: 403,
        detail: 'missing required scope: users:admin',
        instance: '/users/1',
      });
      expect(handler.delete).not.toHaveBeenCalled();
    });
  });

  describe('Custom ID field support', () => {
    it('mounts route on custom role: id field name', async () => {
      const customSpec: EntitySpec = {
        specVersion: '1.2.0',
        entity: 'Device',
        path: 'devices',
        ops: ['get'],
        fields: [
          { name: 'deviceId', type: 'str', role: 'id', readonly: true },
          { name: 'hostname', type: 'str' },
        ],
      };

      const customHandler: EntityHandler = {
        list: jest.fn(),
        get: jest.fn(async (id) => ({ deviceId: id, hostname: 'gateway-1' })),
        create: jest.fn(),
        update: jest.fn(),
        delete: jest.fn(),
      };

      const app = express();
      const router = express.Router();
      mountExpressRoutes(router, customSpec, customHandler);
      app.use(router);

      const res = await request(app).get('/devices/dev-42');
      expect(res.status).toBe(200);
      expect(res.body).toEqual({ deviceId: 'dev-42', hostname: 'gateway-1' });
      expect(customHandler.get).toHaveBeenCalledWith('dev-42');
    });
  });
});
