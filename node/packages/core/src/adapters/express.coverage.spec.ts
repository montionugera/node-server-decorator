import express from 'express';
import request from 'supertest';
import {
  EntityHandler,
  EntitySpec,
  FieldSpec,
  NotFoundError,
  PROBLEM_CONTENT_TYPE,
  VALIDATION_PROBLEM_TYPE,
  enforceScopeAuth,
  mountExpressRoutes,
  resolveEntitySpec,
  validateDto,
  writeProblem,
  writeValidationProblem,
} from './express';

function fakeRes() {
  const res: any = { headers: {} as Record<string, string>, statusCode: undefined, body: undefined };
  res.status = (code: number) => {
    res.statusCode = code;
    return res;
  };
  res.setHeader = (name: string, value: string) => {
    res.headers[name] = value;
    return res;
  };
  res.json = (body: any) => {
    res.body = body;
    return res;
  };
  return res;
}

function specOf(fields: FieldSpec[], extra: Partial<EntitySpec> = {}): EntitySpec {
  return { entity: 'Thing', path: '/things', ops: [], fields, ...extra };
}

/** Validates `value` for a single field named `v` on the create DTO. */
function check(field: Omit<FieldSpec, 'name'>, value: unknown) {
  return validateDto(specOf([{ name: 'v', ...field } as FieldSpec]), 'create', { v: value });
}

const OK = { fields: [], ok: true };
const BAD = { fields: ['v'], ok: false };

describe('NotFoundError', () => {
  it('defaults its message and carries 404 in both status fields', () => {
    const err = new NotFoundError();

    expect(err.message).toBe('Not Found');
    expect(err.name).toBe('NotFoundError');
    expect(err.status).toBe(404);
    expect(err.statusCode).toBe(404);
    expect(err).toBeInstanceOf(NotFoundError);
    expect(err).toBeInstanceOf(Error);
  });

  it('keeps a custom message', () => {
    expect(new NotFoundError('user 7 is gone').message).toBe('user 7 is gone');
  });
});

describe('writeProblem', () => {
  it.each([
    [400, 'Bad Request'],
    [401, 'Unauthorized'],
    [403, 'Forbidden'],
    [404, 'Not Found'],
    [500, 'Internal Server Error'],
    [418, 'Error'],
  ])('uses the default title for %i', (status, title) => {
    const res = fakeRes();

    writeProblem(res, status);

    expect(res.statusCode).toBe(status);
    expect(res.headers['Content-Type']).toBe(PROBLEM_CONTENT_TYPE);
    expect(res.body).toEqual({ type: 'about:blank', title, status });
  });

  it('includes title, detail and instance when given, even as empty strings', () => {
    const res = fakeRes();

    writeProblem(res, 409, 'Conflict', '', '/things/1');

    expect(res.body).toEqual({
      type: 'about:blank',
      title: 'Conflict',
      status: 409,
      detail: '',
      instance: '/things/1',
    });
  });
});

describe('writeValidationProblem', () => {
  it('writes a 400 validation problem with the offending fields and instance', () => {
    const res = fakeRes();

    writeValidationProblem(res, ['age', 'email'], '/things');

    expect(res.statusCode).toBe(400);
    expect(res.headers['Content-Type']).toBe(PROBLEM_CONTENT_TYPE);
    expect(res.body).toEqual({
      type: VALIDATION_PROBLEM_TYPE,
      title: 'Validation Failed',
      status: 400,
      fields: ['age', 'email'],
      instance: '/things',
    });
  });

  it('normalises missing fields to [] and omits an undefined instance', () => {
    const res = fakeRes();

    writeValidationProblem(res, undefined as any);

    expect(res.body).toEqual({
      type: VALIDATION_PROBLEM_TYPE,
      title: 'Validation Failed',
      status: 400,
      fields: [],
    });
  });
});

describe('validateDto coverage', () => {
  describe('dto selection', () => {
    const spec = specOf(
      [
        { name: 'id', type: 'str', role: 'id', readonly: true },
        { name: 'name', type: 'str' },
        { name: 'password', type: 'str', writeonly: true },
      ],
      {
        actions: [
          { name: 'rename', input: [{ name: 'to', type: 'str' }] },
          { name: 'archive' },
        ],
      }
    );

    it('rejects an unknown dto type with _dto', () => {
      expect(validateDto(spec, 'patch', {})).toEqual({ fields: ['_dto'], ok: false });
    });

    it('rejects an unknown action with _action', () => {
      expect(validateDto(spec, 'action:explode', {})).toEqual({ fields: ['_action'], ok: false });
      expect(validateDto(specOf([]), 'action:rename', {})).toEqual({ fields: ['_action'], ok: false });
    });

    it('validates an action payload against that action input only', () => {
      expect(validateDto(spec, 'action:rename', { to: 'b' })).toEqual(OK);
      expect(validateDto(spec, 'action:rename', {})).toEqual({ fields: ['to'], ok: false });
      expect(validateDto(spec, 'action:rename', { to: 'b', name: 'x' })).toEqual({
        fields: ['name'],
        ok: false,
      });
    });

    it('treats an action without input as an empty strict object', () => {
      expect(validateDto(spec, 'action:archive', {})).toEqual(OK);
      expect(validateDto(spec, 'action:archive', { extra: 1 })).toEqual({
        fields: ['extra'],
        ok: false,
      });
    });

    it('create excludes readonly fields, so supplying one is an unknown key', () => {
      expect(validateDto(spec, 'create', { name: 'n', password: 'p' })).toEqual(OK);
      expect(validateDto(spec, 'create', { id: '1', name: 'n', password: 'p' })).toEqual({
        fields: ['id'],
        ok: false,
      });
    });

    it('update makes every writable field optional but still type-checks what is sent', () => {
      expect(validateDto(spec, 'update', {})).toEqual(OK);
      expect(validateDto(spec, 'update', { name: 5 })).toEqual({ fields: ['name'], ok: false });
      expect(validateDto(spec, 'update', { id: '1' })).toEqual({ fields: ['id'], ok: false });
    });

    it('read excludes writeonly fields and requires readonly ones', () => {
      expect(validateDto(spec, 'read', { id: '1', name: 'n' })).toEqual(OK);
      expect(validateDto(spec, 'read', { id: '1', name: 'n', password: 'p' })).toEqual({
        fields: ['password'],
        ok: false,
      });
      expect(validateDto(spec, 'read', { name: 'n' })).toEqual({ fields: ['id'], ok: false });
    });

    it('tolerates a spec without a fields array', () => {
      const bare = { entity: 'T', path: '/t', ops: [] } as unknown as EntitySpec;

      expect(validateDto(bare, 'create', {})).toEqual(OK);
      expect(validateDto(bare, 'update', {})).toEqual(OK);
      expect(validateDto(bare, 'read', { a: 1 })).toEqual({ fields: ['a'], ok: false });
    });
  });

  describe('root and presence', () => {
    const spec = specOf([
      { name: 'b', type: 'str' },
      { name: 'a', type: 'str' },
      { name: 'opt', type: 'str', optional: true },
      { name: 'nul', type: 'str', nullable: true },
    ]);

    it.each([[null], [undefined], ['text'], [7], [[]]])('reports _root for the payload %p', (payload) => {
      expect(validateDto(spec, 'create', payload)).toEqual({ fields: ['_root'], ok: false });
    });

    it('reports missing required fields sorted, and lets optional ones be absent', () => {
      expect(validateDto(spec, 'create', {})).toEqual({ fields: ['a', 'b', 'nul'], ok: false });
    });

    it('accepts null only on nullable fields', () => {
      expect(validateDto(spec, 'create', { a: 'x', b: 'y', nul: null })).toEqual(OK);
      expect(validateDto(spec, 'create', { a: null, b: 'y', nul: null, opt: null })).toEqual({
        fields: ['a', 'opt'],
        ok: false,
      });
    });

    it('treats a present-but-undefined value as a type error, not as missing', () => {
      expect(validateDto(spec, 'create', { a: 'x', b: 'y', nul: 'z', opt: undefined })).toEqual({
        fields: ['opt'],
        ok: false,
      });
    });

    it('does not read inherited properties as present', () => {
      const payload = Object.create({ a: 'inherited' });
      payload.b = 'y';
      payload.nul = null;

      expect(validateDto(spec, 'create', payload)).toEqual({ fields: ['a'], ok: false });
    });
  });

  describe('str / ref', () => {
    it.each([[1], [true], [{}], [[]]])('rejects the non-string %p', (value) => {
      expect(check({ type: 'str' }, value)).toEqual(BAD);
      expect(check({ type: 'ref', ref: 'Other' }, value)).toEqual(BAD);
    });

    it('accepts any string, including empty, without constraints', () => {
      expect(check({ type: 'str' }, '')).toEqual(OK);
      expect(check({ type: 'ref', ref: 'Other' }, 'abc')).toEqual(OK);
    });

    it('enforces min/max inclusively', () => {
      const f = { type: 'str', min: 2, max: 4 } as const;

      expect(check(f, 'a')).toEqual(BAD);
      expect(check(f, 'ab')).toEqual(OK);
      expect(check(f, 'abcd')).toEqual(OK);
      expect(check(f, 'abcde')).toEqual(BAD);
    });

    it('counts Unicode code points, not UTF-16 units', () => {
      // Each emoji is 2 UTF-16 code units but 1 code point.
      expect(check({ type: 'str', max: 2 }, '😀😀')).toEqual(OK);
      expect(check({ type: 'str', min: 3 }, '😀😀')).toEqual(BAD);
    });

    it('min of 0 accepts the empty string and max of 0 accepts nothing else', () => {
      expect(check({ type: 'str', min: 0 }, '')).toEqual(OK);
      expect(check({ type: 'str', max: 0 }, '')).toEqual(OK);
      expect(check({ type: 'str', max: 0 }, 'a')).toEqual(BAD);
    });

    it.each([
      ['email', 'a.b+c@example.co', true],
      ['email', 'no-at-sign', false],
      ['email', 'a@b@c', false],
      ['email', 'a@-bad.com', false],
      ['uuid', '123e4567-e89b-12d3-a456-426614174000', true],
      ['uuid', '123E4567-E89B-12D3-A456-426614174000', true],
      ['uuid', '123e4567e89b12d3a456426614174000', false],
      ['uuid', '123e4567-e89b-12d3-a456-42661417400g', false],
      ['uri', 'https://example.com/a?b=1', true],
      ['uri', 'custom+scheme.v1://host', true],
      ['uri', 'example.com', false],
      ['uri', 'https://has space', false],
      ['uri', '1http://x', false],
    ] as const)('format %s on %p -> valid=%p', (format, value, valid) => {
      expect(check({ type: 'str', format }, value)).toEqual(valid ? OK : BAD);
    });

    it('applies a custom pattern only when no format is set', () => {
      expect(check({ type: 'str', pattern: '^[a-z]+$' }, 'abc')).toEqual(OK);
      expect(check({ type: 'str', pattern: '^[a-z]+$' }, 'abc1')).toEqual(BAD);
      // format wins: the pattern would reject this valid email.
      expect(check({ type: 'str', format: 'email', pattern: '^x$' }, 'a@b.co')).toEqual(OK);
    });

    it('fails closed on an uncompilable pattern', () => {
      expect(check({ type: 'str', pattern: '(' }, 'anything')).toEqual(BAD);
    });

    it('checks length before format', () => {
      expect(check({ type: 'str', format: 'email', max: 5 }, 'a@b.co')).toEqual(BAD);
    });
  });

  describe('int', () => {
    it.each([[1.5], ['1'], [NaN], [Infinity], [-Infinity], [true], [null as any]])(
      'rejects %p',
      (value) => {
        expect(check({ type: 'int', nullable: false }, value)).toEqual(BAD);
      }
    );

    it('accepts zero, negatives and whole-number floats', () => {
      expect(check({ type: 'int' }, 0)).toEqual(OK);
      expect(check({ type: 'int' }, -3)).toEqual(OK);
      expect(check({ type: 'int' }, 2.0)).toEqual(OK);
      expect(check({ type: 'int' }, Number.MAX_SAFE_INTEGER)).toEqual(OK);
    });

    it('enforces min/max inclusively, including a bound of 0', () => {
      const f = { type: 'int', min: 0, max: 10 } as const;

      expect(check(f, -1)).toEqual(BAD);
      expect(check(f, 0)).toEqual(OK);
      expect(check(f, 10)).toEqual(OK);
      expect(check(f, 11)).toEqual(BAD);
    });
  });

  describe('float', () => {
    it.each([[NaN], [Infinity], [-Infinity], ['1.5'], [false]])('rejects %p', (value) => {
      expect(check({ type: 'float' }, value)).toEqual(BAD);
    });

    it('accepts integers, fractions and negative zero', () => {
      expect(check({ type: 'float' }, 3)).toEqual(OK);
      expect(check({ type: 'float' }, -0)).toEqual(OK);
      expect(check({ type: 'float' }, 0.1)).toEqual(OK);
      expect(check({ type: 'float' }, Number.MAX_VALUE)).toEqual(OK);
    });

    it('enforces min/max inclusively', () => {
      const f = { type: 'float', min: -1, max: 1 } as const;

      expect(check(f, -1.0001)).toEqual(BAD);
      expect(check(f, -1)).toEqual(OK);
      expect(check(f, 1)).toEqual(OK);
      expect(check(f, 1.0001)).toEqual(BAD);
    });
  });

  describe('bool', () => {
    it('accepts only real booleans', () => {
      expect(check({ type: 'bool' }, true)).toEqual(OK);
      expect(check({ type: 'bool' }, false)).toEqual(OK);
      expect(check({ type: 'bool' }, 0)).toEqual(BAD);
      expect(check({ type: 'bool' }, 'true')).toEqual(BAD);
    });
  });

  describe('datetime', () => {
    it.each([
      ['2024-01-02T03:04:05Z'],
      ['2024-01-02T03:04:05.123Z'],
      ['2024-01-02T03:04:05+07:00'],
      ['2024-01-02T03:04:05-05:30'],
    ])('accepts %p', (value) => {
      expect(check({ type: 'datetime' }, value)).toEqual(OK);
    });

    it.each([
      ['a number', 1704164645000],
      ['a Date object', new Date(0)],
      ['an unparseable string', 'not-a-date'],
      ['an empty string', ''],
      ['a local time without offset', '2024-01-02T03:04:05'],
      ['a date only', '2024-01-02'],
      ['a bare year (shorter than an offset)', '2024'],
      ['an impossible date with Z', '2024-13-45T00:00:00Z'],
    ])('rejects %s', (_label, value) => {
      expect(check({ type: 'datetime' }, value)).toEqual(BAD);
    });
  });

  describe('enum', () => {
    it('accepts only listed string members', () => {
      const f = { type: 'enum', enum: ['admin', 'member'] } as const;

      expect(check(f as any, 'admin')).toEqual(OK);
      expect(check(f as any, 'ADMIN')).toEqual(BAD);
      expect(check(f as any, '')).toEqual(BAD);
      expect(check(f as any, 0)).toEqual(BAD);
    });

    it('rejects everything when the enum list is missing or empty', () => {
      expect(check({ type: 'enum' }, 'admin')).toEqual(BAD);
      expect(check({ type: 'enum', enum: [] }, 'admin')).toEqual(BAD);
    });
  });

  describe('list', () => {
    it.each([['a,b'], [{ 0: 'a' }], [3]])('rejects the non-array %p', (value) => {
      expect(check({ type: 'list', item: { name: 'item', type: 'str' } }, value)).toEqual(BAD);
    });

    it('accepts an empty list', () => {
      expect(check({ type: 'list', item: { name: 'item', type: 'str' } }, [])).toEqual(OK);
    });

    it('reports each bad element by index, including null elements', () => {
      const result = check({ type: 'list', item: { name: 'item', type: 'int', min: 0 } }, [
        1,
        'two',
        -3,
        null,
        4,
      ]);

      expect(result).toEqual({ fields: ['v.1', 'v.2', 'v.3'], ok: false });
    });

    it('does not inspect elements when no item spec is declared', () => {
      expect(check({ type: 'list' }, [1, 'two', null, {}])).toEqual(OK);
    });

    it('validates lists of lists with nested index paths', () => {
      const f: Omit<FieldSpec, 'name'> = {
        type: 'list',
        item: { name: 'row', type: 'list', item: { name: 'cell', type: 'bool' } },
      };

      expect(check(f, [[true], [false, 1]])).toEqual({ fields: ['v.1.1'], ok: false });
      expect(check(f, [[true], 'row'])).toEqual({ fields: ['v.1'], ok: false });
    });
  });

  describe('obj', () => {
    const address: Omit<FieldSpec, 'name'> = {
      type: 'obj',
      fields: [
        { name: 'city', type: 'str' },
        { name: 'zip', type: 'str', optional: true },
        { name: 'geoId', type: 'str', readonly: true },
        { name: 'secret', type: 'str', writeonly: true },
      ],
    };

    it.each([['street'], [[]], [5]])('reports the field path for the non-object %p', (value) => {
      expect(check(address, value)).toEqual(BAD);
    });

    it('reports nested missing, mistyped and unknown keys with dotted paths', () => {
      expect(check(address, { zip: 1, planet: 'x', secret: 's' })).toEqual({
        fields: ['v.city', 'v.planet', 'v.zip'],
        ok: false,
      });
    });

    it('filters nested readonly members out of create and update', () => {
      const spec = specOf([{ name: 'v', ...address } as FieldSpec]);

      expect(validateDto(spec, 'create', { v: { city: 'c', secret: 's' } })).toEqual(OK);
      expect(validateDto(spec, 'create', { v: { city: 'c', secret: 's', geoId: 'g' } })).toEqual({
        fields: ['v.geoId'],
        ok: false,
      });
      expect(validateDto(spec, 'update', { v: { city: 'c', secret: 's', geoId: 'g' } })).toEqual({
        fields: ['v.geoId'],
        ok: false,
      });
    });

    it('filters nested writeonly members out of read', () => {
      const spec = specOf([{ name: 'v', ...address } as FieldSpec]);

      expect(validateDto(spec, 'read', { v: { city: 'c', geoId: 'g' } })).toEqual(OK);
      expect(validateDto(spec, 'read', { v: { city: 'c', geoId: 'g', secret: 's' } })).toEqual({
        fields: ['v.secret'],
        ok: false,
      });
    });

    it('applies the include rule to objects inside lists too', () => {
      const spec = specOf([{ name: 'v', type: 'list', item: { name: 'item', ...address } as FieldSpec }]);

      expect(
        validateDto(spec, 'create', { v: [{ city: 'a', secret: 's' }, { city: 'b', secret: 's', geoId: 'g' }] })
      ).toEqual({ fields: ['v.1.geoId'], ok: false });
    });

    it('an obj without declared fields only accepts the empty object', () => {
      expect(check({ type: 'obj' }, {})).toEqual(OK);
      expect(check({ type: 'obj' }, { a: 1 })).toEqual({ fields: ['v.a'], ok: false });
    });
  });

  it('rejects a value whose field type is unknown to the validator', () => {
    expect(check({ type: 'decimal' as any }, 1)).toEqual(BAD);
  });

  it('reports each failing field once and in sorted order', () => {
    const spec = specOf([
      { name: 'z', type: 'int', min: 5, max: 1 },
      { name: 'm', type: 'bool' },
      { name: 'a', type: 'float' },
    ]);

    // z=3 violates both min and max but is listed once.
    expect(validateDto(spec, 'create', { z: 3, m: 'no', a: NaN })).toEqual({
      fields: ['a', 'm', 'z'],
      ok: false,
    });
  });
});

describe('resolveEntitySpec', () => {
  const spec = specOf([{ name: 'id', type: 'str', role: 'id' }]);

  afterEach(() => {
    jest.resetModules();
  });

  it.each([[null], [undefined], [0], ['']])('throws for the falsy input %p', (input) => {
    expect(() => resolveEntitySpec(input)).toThrow('specOrClass is required');
  });

  it('returns a plain spec object as-is', () => {
    expect(resolveEntitySpec(spec)).toBe(spec);
  });

  it('calls a static entitySpec() method', () => {
    class Thing {
      static entitySpec() {
        return spec;
      }
    }

    expect(resolveEntitySpec(Thing)).toBe(spec);
  });

  it('reads a static entitySpec object', () => {
    class Thing {
      static entitySpec = spec;
    }

    expect(resolveEntitySpec(Thing)).toBe(spec);
  });

  it('reads a static __entity_spec__ marker', () => {
    class Thing {
      static __entity_spec__ = spec;
    }

    expect(resolveEntitySpec(Thing)).toBe(spec);
  });

  it('prefers entitySpec() over __entity_spec__', () => {
    const other = specOf([]);
    class Thing {
      static __entity_spec__ = other;
      static entitySpec() {
        return spec;
      }
    }

    expect(resolveEntitySpec(Thing)).toBe(spec);
  });

  it('delegates an undecorated class to @montionugera/entity-spec when installed', () => {
    const seen: unknown[] = [];
    jest.doMock(
      '@montionugera/entity-spec',
      () => ({
        entitySpec: (cls: unknown) => {
          seen.push(cls);
          return spec;
        },
      }),
      { virtual: true }
    );
    class Thing {}

    expect(resolveEntitySpec(Thing)).toBe(spec);
    expect(seen).toEqual([Thing]);
  });

  it('falls back to @montionugera/server-decorator-entity when the first package rejects the class', () => {
    jest.doMock(
      '@montionugera/entity-spec',
      () => ({
        entitySpec: () => {
          throw new Error('not a @Restful class');
        },
      }),
      { virtual: true }
    );
    jest.doMock(
      '@montionugera/server-decorator-entity',
      () => ({ entitySpec: () => spec }),
      { virtual: true }
    );
    class Thing {}

    expect(resolveEntitySpec(Thing)).toBe(spec);
  });

  it('throws naming the constructor when no resolver can produce a spec', () => {
    const reject = () => ({
      entitySpec: () => {
        throw new Error('not a @Restful class');
      },
    });
    jest.doMock('@montionugera/entity-spec', reject, { virtual: true });
    jest.doMock('@montionugera/server-decorator-entity', reject, { virtual: true });
    class Orphan {}

    expect(() => resolveEntitySpec(Orphan)).toThrow(
      'Unable to resolve EntitySpec from constructor Orphan'
    );
  });
});

describe('enforceScopeAuth', () => {
  async function run(
    required: string[],
    extractor: any,
    req: any = { originalUrl: '/things?x=1', url: '/ignored' }
  ) {
    const res = fakeRes();
    let nextCalls = 0;
    await enforceScopeAuth(required, extractor)(req, res, () => {
      nextCalls += 1;
    });
    return { res, nextCalls };
  }

  const unauthorized = (instance: string) => ({
    type: 'about:blank',
    title: 'Unauthorized',
    status: 401,
    detail: 'authentication required',
    instance,
  });

  it('fails closed with 401 when no extractor is configured', async () => {
    const { res, nextCalls } = await run(['a'], undefined);

    expect(nextCalls).toBe(0);
    expect(res.statusCode).toBe(401);
    expect(res.body).toEqual(unauthorized('/things?x=1'));
  });

  it('falls back to req.url for the instance when originalUrl is absent', async () => {
    const { res } = await run(['a'], undefined, { url: '/mounted' });

    expect(res.body.instance).toBe('/mounted');
  });

  it('answers 401 when the extractor throws or rejects', async () => {
    const sync = await run([], () => {
      throw new Error('bad token');
    });
    const rejected = await run([], async () => {
      throw new Error('bad token');
    });

    for (const { res, nextCalls } of [sync, rejected]) {
      expect(nextCalls).toBe(0);
      expect(res.body).toEqual(unauthorized('/things?x=1'));
    }
  });

  it.each([
    ['unauthenticated', { authenticated: false, scopes: ['a'] }],
    ['null', null],
    ['undefined', undefined],
  ])('answers 401 for an %s extractor result', async (_label, result) => {
    const { res, nextCalls } = await run(['a'], () => result);

    expect(nextCalls).toBe(0);
    expect(res.statusCode).toBe(401);
  });

  it('answers 403 naming the first missing scope', async () => {
    const { res, nextCalls } = await run(['a', 'b', 'c'], async () => ({
      authenticated: true,
      scopes: ['a'],
    }));

    expect(nextCalls).toBe(0);
    expect(res.body).toEqual({
      type: 'about:blank',
      title: 'Forbidden',
      status: 403,
      detail: 'missing required scope: b',
      instance: '/things?x=1',
    });
  });

  it('answers 403 when an authenticated caller reports no scopes at all', async () => {
    const { res, nextCalls } = await run(['a'], () => ({ authenticated: true }));

    expect(nextCalls).toBe(0);
    expect(res.body.detail).toBe('missing required scope: a');
  });

  it('calls next exactly once and writes nothing when every scope is held', async () => {
    const seenReqs: any[] = [];
    const req = { originalUrl: '/things' };
    const { res, nextCalls } = await run(
      ['a', 'b'],
      (r: any) => {
        seenReqs.push(r);
        return { authenticated: true, scopes: ['b', 'a', 'extra'] };
      },
      req
    );

    expect(nextCalls).toBe(1);
    expect(res.statusCode).toBeUndefined();
    expect(res.body).toBeUndefined();
    expect(seenReqs).toEqual([req]);
  });

  it('an empty scope list only requires authentication', async () => {
    const { nextCalls } = await run([], () => ({ authenticated: true, scopes: [] }));

    expect(nextCalls).toBe(1);
  });
});

describe('mountExpressRoutes coverage', () => {
  const baseSpec: EntitySpec = {
    entity: 'Thing',
    path: '//things/',
    ops: ['list', 'get', 'create', 'update', 'delete'],
    fields: [
      { name: 'slug', type: 'str', role: 'id', readonly: true },
      { name: 'name', type: 'str', filterable: true },
      { name: 'kind', type: 'str', optional: true, filterable: true },
      { name: 'note', type: 'str', optional: true },
    ],
    actions: [
      { name: 'rename', input: [{ name: 'to', type: 'str' }] },
      { name: 'archive' },
    ],
  };

  function buildApp(
    handler: Partial<EntityHandler>,
    spec: EntitySpec = baseSpec,
    options?: Parameters<typeof mountExpressRoutes>[3],
    parseJson = true
  ) {
    const app = express();
    if (parseJson) app.use(express.json());
    const router = express.Router();
    const returned = mountExpressRoutes(router, spec, handler as EntityHandler, options);
    app.use(router);
    return { app, router, returned };
  }

  function expectProblem(res: request.Response, status: number, title: string, detail: string, instance: string) {
    expect(res.status).toBe(status);
    expect(res.headers['content-type']).toContain(PROBLEM_CONTENT_TYPE);
    expect(res.body).toEqual({ type: 'about:blank', title, status, detail, instance });
  }

  function expectValidation(res: request.Response, fields: string[], instance: string) {
    expect(res.status).toBe(400);
    expect(res.headers['content-type']).toContain(PROBLEM_CONTENT_TYPE);
    expect(res.body).toEqual({
      type: VALIDATION_PROBLEM_TYPE,
      title: 'Validation Failed',
      status: 400,
      fields,
      instance,
    });
  }

  it('returns the router it was given and throws when the spec is missing', () => {
    const { router, returned } = buildApp({});

    expect(returned).toBe(router);
    expect(() => mountExpressRoutes(express.Router(), null, {} as EntityHandler)).toThrow(
      'specOrClass is required'
    );
  });

  it('mounts only the declared ops and ignores unknown ones', async () => {
    const { app } = buildApp(
      { get: async (id) => ({ slug: id }) },
      { ...baseSpec, ops: ['get', 'teleport'], actions: undefined }
    );

    expect((await request(app).get('/things/a')).body).toEqual({ slug: 'a' });
    expect((await request(app).get('/things')).status).toBe(404);
    expect((await request(app).post('/things').send({ name: 'n' })).status).toBe(404);
    expect((await request(app).delete('/things/a')).status).toBe(404);
    expect((await request(app).post('/things/a/actions/archive')).status).toBe(404);
  });

  it("defaults the id parameter to 'id' when no field has the id role and ops are absent", async () => {
    const spec = {
      entity: 'Thing',
      path: 'things',
      actions: [{ name: 'ping' }],
    } as unknown as EntitySpec;
    const calls: any[] = [];
    const { app } = buildApp(
      { action: async (id, name, data) => { calls.push([id, name, data]); return { ok: true }; } },
      spec
    );

    const res = await request(app).post('/things/42/actions/ping');

    expect(res.status).toBe(200);
    expect(calls).toEqual([['42', 'ping', {}]]);
  });

  describe('list', () => {
    function listApp(...given: any[]) {
      // Not a default parameter: an explicit `undefined` result must stay undefined.
      const result = given.length > 0 ? given[0] : { items: [{ slug: 'a' }], total: 1 };
      const seen: any[] = [];
      const { app } = buildApp({
        list: async (params) => {
          seen.push(params);
          return result;
        },
      });
      return { app, seen };
    }

    it('defaults to limit 20 / offset 0 with no filters', async () => {
      const { app, seen } = listApp();

      const res = await request(app).get('/things');

      expect(res.status).toBe(200);
      expect(res.body).toEqual({ items: [{ slug: 'a' }], total: 1, limit: 20, offset: 0 });
      expect(seen).toEqual([{ limit: 20, offset: 0, filters: {} }]);
    });

    it.each([
      ['limit=5&offset=7', 5, 7],
      ['limit=0', 0, 0],
      ['limit=100', 100, 0],
      ['limit=101', 100, 0],
      ['limit=999999', 100, 0],
      ['limit=-1', 20, 0],
      ['limit=abc', 20, 0],
      ['limit=', 20, 0],
      ['limit=7.9', 7, 0],
      ['offset=-3', 20, 0],
      ['offset=xyz', 20, 0],
      ['offset=1000000', 20, 1000000],
    ])('paginates ?%s as limit=%i offset=%i', async (query, limit, offset) => {
      const { app, seen } = listApp();

      const res = await request(app).get(`/things?${query}`);

      expect(res.body.limit).toBe(limit);
      expect(res.body.offset).toBe(offset);
      expect(seen[0].limit).toBe(limit);
      expect(seen[0].offset).toBe(offset);
    });

    it('forwards only filterable fields as string filters', async () => {
      const { app, seen } = listApp();

      await request(app).get('/things?name=bob&kind=7&note=secret&unknown=1');

      expect(seen[0].filters).toEqual({ name: 'bob', kind: '7' });
    });

    it.each([[null], [undefined], [{}]])('answers an empty page when the handler returns %p', async (result) => {
      const { app } = listApp(result);

      const res = await request(app).get('/things');

      expect(res.status).toBe(200);
      expect(res.body).toEqual({ items: [], total: 0, limit: 20, offset: 0 });
    });

    it('keeps a total of 0 alongside items', async () => {
      const { app } = listApp({ items: [1], total: 0 });

      expect((await request(app).get('/things')).body.total).toBe(0);
    });

    it('maps a handler failure to a 500 problem', async () => {
      const { app } = buildApp({
        list: async () => {
          throw new Error('db offline');
        },
      });

      expectProblem(
        await request(app).get('/things?limit=1'),
        500,
        'Internal Server Error',
        'db offline',
        '/things?limit=1'
      );
    });

    it('uses a generic detail when the thrown value has no message', async () => {
      const { app } = buildApp({
        list: async () => {
          throw undefined;
        },
      });

      expectProblem(
        await request(app).get('/things'),
        500,
        'Internal Server Error',
        'Internal server error',
        '/things'
      );
    });
  });

  describe('get', () => {
    it('returns the entity looked up by the id-role field', async () => {
      const ids: string[] = [];
      const { app } = buildApp({
        get: async (id) => {
          ids.push(id);
          return { slug: id, name: 'n' };
        },
      });

      const res = await request(app).get('/things/my-slug');

      expect(res.status).toBe(200);
      expect(res.body).toEqual({ slug: 'my-slug', name: 'n' });
      expect(ids).toEqual(['my-slug']);
    });

    it.each([[null], [undefined]])('answers 404 when the handler returns %p', async (result) => {
      const { app } = buildApp({ get: async () => result });

      expectProblem(
        await request(app).get('/things/x'),
        404,
        'Not Found',
        'entity with id x not found',
        '/things/x'
      );
    });

    it('returns falsy-but-present entities instead of treating them as missing', async () => {
      const { app } = buildApp({ get: async () => 0 as any });

      const res = await request(app).get('/things/x');

      expect(res.status).toBe(200);
      expect(res.body).toBe(0);
    });

    it.each([
      ['NotFoundError', new NotFoundError('gone for good'), 'gone for good'],
      ['status: 404', Object.assign(new Error('no such thing'), { status: 404 }), 'no such thing'],
      ['statusCode: 404', Object.assign(new Error(''), { statusCode: 404 }), 'entity with id x not found'],
    ])('maps a thrown %s to a 404 problem', async (_label, error, detail) => {
      const { app } = buildApp({
        get: async () => {
          throw error;
        },
      });

      expectProblem(await request(app).get('/things/x'), 404, 'Not Found', detail, '/things/x');
    });

    it('maps any other failure, including non-404 status errors, to 500', async () => {
      const { app } = buildApp({
        get: async () => {
          throw Object.assign(new Error('conflict'), { status: 409 });
        },
      });

      expectProblem(
        await request(app).get('/things/x'),
        500,
        'Internal Server Error',
        'conflict',
        '/things/x'
      );
    });
  });

  describe('create', () => {
    it('answers 201 with the handler result and passes the body through', async () => {
      const bodies: any[] = [];
      const { app } = buildApp({
        create: async (data) => {
          bodies.push(data);
          return { slug: 's1', ...data };
        },
      });

      const res = await request(app).post('/things').send({ name: 'n' });

      expect(res.status).toBe(201);
      expect(res.body).toEqual({ slug: 's1', name: 'n' });
      expect(bodies).toEqual([{ name: 'n' }]);
    });

    it('rejects an array body with _body and never calls the handler', async () => {
      let calls = 0;
      const { app } = buildApp({
        create: async () => {
          calls += 1;
          return {};
        },
      });

      expectValidation(await request(app).post('/things').send([{ name: 'n' }]), ['_body'], '/things');
      expect(calls).toBe(0);
    });

    it('rejects a request whose body was never parsed with _body', async () => {
      const { app } = buildApp({ create: async () => ({}) }, baseSpec, undefined, false);

      expectValidation(await request(app).post('/things').send({ name: 'n' }), ['_body'], '/things');
    });

    it('lists every invalid field, sorted, and never calls the handler', async () => {
      let calls = 0;
      const { app } = buildApp({
        create: async () => {
          calls += 1;
          return {};
        },
      });

      expectValidation(
        await request(app).post('/things').send({ slug: 'client-chosen', zzz: 1, kind: 5 }),
        ['kind', 'name', 'slug', 'zzz'],
        '/things'
      );
      expect(calls).toBe(0);
    });

    it('maps a handler failure to a 500 problem', async () => {
      const { app } = buildApp({
        create: async () => {
          throw new Error('unique violation');
        },
      });

      expectProblem(
        await request(app).post('/things').send({ name: 'n' }),
        500,
        'Internal Server Error',
        'unique violation',
        '/things'
      );
    });

    it('does not turn a NotFoundError from create into a 404', async () => {
      const { app } = buildApp({
        create: async () => {
          throw new NotFoundError('parent missing');
        },
      });

      const res = await request(app).post('/things').send({ name: 'n' });

      expect(res.status).toBe(500);
      expect(res.body.detail).toBe('parent missing');
    });
  });

  describe('update', () => {
    it('answers 200 and forwards id and partial body', async () => {
      const calls: any[] = [];
      const { app } = buildApp({
        update: async (id, data) => {
          calls.push([id, data]);
          return { slug: id, name: 'old', ...data };
        },
      });

      const res = await request(app).patch('/things/a').send({ note: 'hi' });

      expect(res.status).toBe(200);
      expect(res.body).toEqual({ slug: 'a', name: 'old', note: 'hi' });
      expect(calls).toEqual([['a', { note: 'hi' }]]);
    });

    it('accepts an empty patch', async () => {
      const { app } = buildApp({ update: async (id) => ({ slug: id }) });

      expect((await request(app).patch('/things/a').send({})).status).toBe(200);
    });

    it('rejects an array body and an unparsed body with _body', async () => {
      const parsed = buildApp({ update: async () => ({}) });
      const unparsed = buildApp({ update: async () => ({}) }, baseSpec, undefined, false);

      expectValidation(await request(parsed.app).patch('/things/a').send([1]), ['_body'], '/things/a');
      expectValidation(
        await request(unparsed.app).patch('/things/a').send({ name: 'n' }),
        ['_body'],
        '/things/a'
      );
    });

    it('rejects readonly and mistyped fields without calling the handler', async () => {
      let calls = 0;
      const { app } = buildApp({
        update: async () => {
          calls += 1;
          return {};
        },
      });

      expectValidation(
        await request(app).patch('/things/a').send({ slug: 'b', name: null }),
        ['name', 'slug'],
        '/things/a'
      );
      expect(calls).toBe(0);
    });

    it.each([[null], [undefined]])('answers 404 when the handler returns %p', async (result) => {
      const { app } = buildApp({ update: async () => result });

      expectProblem(
        await request(app).patch('/things/a').send({ name: 'n' }),
        404,
        'Not Found',
        'entity with id a not found',
        '/things/a'
      );
    });

    it.each([
      ['NotFoundError', new NotFoundError('vanished'), 404, 'Not Found', 'vanished'],
      ['status 404 without message', { status: 404 }, 404, 'Not Found', 'entity with id a not found'],
      ['statusCode 404', Object.assign(new Error('nope'), { statusCode: 404 }), 404, 'Not Found', 'nope'],
      ['generic error', new Error('deadlock'), 500, 'Internal Server Error', 'deadlock'],
      ['message-less throw', {}, 500, 'Internal Server Error', 'Internal server error'],
    ])('maps a thrown %s', async (_label, error, status, title, detail) => {
      const { app } = buildApp({
        update: async () => {
          throw error;
        },
      });

      expectProblem(
        await request(app).patch('/things/a').send({ name: 'n' }),
        status,
        title,
        detail,
        '/things/a'
      );
    });
  });

  describe('delete', () => {
    it('answers 204 with an empty body', async () => {
      const ids: string[] = [];
      const { app } = buildApp({
        delete: async (id) => {
          ids.push(id);
        },
      });

      const res = await request(app).delete('/things/a');

      expect(res.status).toBe(204);
      expect(res.text).toBe('');
      expect(ids).toEqual(['a']);
    });

    it.each([
      ['NotFoundError', new NotFoundError(), 404, 'Not Found', 'Not Found'],
      ['status 404 without message', { status: 404 }, 404, 'Not Found', 'entity with id a not found'],
      ['statusCode 404', { statusCode: 404, message: 'already deleted' }, 404, 'Not Found', 'already deleted'],
      ['generic error', new Error('fk constraint'), 500, 'Internal Server Error', 'fk constraint'],
      ['null throw', null, 500, 'Internal Server Error', 'Internal server error'],
    ])('maps a thrown %s', async (_label, error, status, title, detail) => {
      const { app } = buildApp({
        delete: async () => {
          throw error;
        },
      });

      expectProblem(await request(app).delete('/things/a'), status, title, detail, '/things/a');
    });
  });

  describe('actions', () => {
    it('validates the input and forwards id, action name and body', async () => {
      const calls: any[] = [];
      const { app } = buildApp({
        action: async (id, name, data) => {
          calls.push([id, name, data]);
          return { renamed: true };
        },
      });

      const res = await request(app).post('/things/a/actions/rename').send({ to: 'b' });

      expect(res.status).toBe(200);
      expect(res.body).toEqual({ renamed: true });
      expect(calls).toEqual([['a', 'rename', { to: 'b' }]]);
    });

    it('rejects invalid action input without calling the handler', async () => {
      let calls = 0;
      const { app } = buildApp({
        action: async () => {
          calls += 1;
        },
      });

      expectValidation(
        await request(app).post('/things/a/actions/rename').send({ to: 5, extra: true }),
        ['extra', 'to'],
        '/things/a/actions/rename'
      );
      expectValidation(
        await request(app).post('/things/a/actions/rename').send([{ to: 'b' }]),
        ['_body'],
        '/things/a/actions/rename'
      );
      expect(calls).toBe(0);
    });

    it('treats a missing body as {} and so reports the required input field', async () => {
      const { app } = buildApp({ action: async () => ({}) }, baseSpec, undefined, false);

      expectValidation(
        await request(app).post('/things/a/actions/rename'),
        ['to'],
        '/things/a/actions/rename'
      );
    });

    it('skips validation for an input-less action and defaults the body to {}', async () => {
      const calls: any[] = [];
      const { app } = buildApp(
        {
          action: async (id, name, data) => {
            calls.push([id, name, data]);
            return { archived: true };
          },
        },
        baseSpec,
        undefined,
        false
      );

      const res = await request(app).post('/things/a/actions/archive');

      expect(res.status).toBe(200);
      expect(res.body).toEqual({ archived: true });
      expect(calls).toEqual([['a', 'archive', {}]]);
    });

    it('answers 500 when the handler does not implement actions', async () => {
      const { app } = buildApp({});

      expectProblem(
        await request(app).post('/things/a/actions/archive'),
        500,
        'Internal Server Error',
        'Handler does not support actions',
        '/things/a/actions/archive'
      );
    });

    it.each([
      ['NotFoundError', new NotFoundError('no thing a'), 404, 'Not Found', 'no thing a'],
      ['status 404 without message', { status: 404 }, 404, 'Not Found', 'entity with id a not found'],
      ['statusCode 404', { statusCode: 404, message: 'missing' }, 404, 'Not Found', 'missing'],
      ['generic error', new Error('boom'), 500, 'Internal Server Error', 'boom'],
      ['message-less throw', {}, 500, 'Internal Server Error', 'Internal server error'],
    ])('maps a thrown %s', async (_label, error, status, title, detail) => {
      const { app } = buildApp({
        action: async () => {
          throw error;
        },
      });

      expectProblem(
        await request(app).post('/things/a/actions/archive'),
        status,
        title,
        detail,
        '/things/a/actions/archive'
      );
    });
  });

  describe('security', () => {
    const secured: EntitySpec = {
      ...baseSpec,
      security: {
        ops: {
          create: ['things:write'],
          get: [],
          // Not an array: declares nothing enforceable, so no middleware is added.
          delete: 'things:delete' as any,
        },
        actions: { archive: ['things:admin'], rename: 'oops' as any },
      },
    };
    const handler: Partial<EntityHandler> = {
      list: async () => ({ items: [], total: 0 }),
      get: async (id) => ({ slug: id }),
      create: async (data) => ({ slug: 'new', ...data }),
      delete: async () => undefined,
      action: async () => ({ done: true }),
    };
    const byHeader = (req: any) => {
      const raw = req.headers['x-scopes'];
      if (raw === undefined) return { authenticated: false, scopes: [] };
      return { authenticated: true, scopes: String(raw).split(',').filter(Boolean) };
    };

    it('fails closed on secured ops and actions when no extractor is configured', async () => {
      const { app } = buildApp(handler, secured);

      const create = await request(app).post('/things').send({ name: 'n' });
      const action = await request(app).post('/things/a/actions/archive');

      expectProblem(create, 401, 'Unauthorized', 'authentication required', '/things');
      expectProblem(action, 401, 'Unauthorized', 'authentication required', '/things/a/actions/archive');
    });

    it('leaves ops without a security entry open', async () => {
      const { app } = buildApp(handler, secured);

      expect((await request(app).get('/things')).status).toBe(200);
    });

    it('adds no guard for a non-array security entry', async () => {
      const { app } = buildApp(handler, secured, { authExtractor: byHeader });

      expect((await request(app).delete('/things/a')).status).toBe(204);
      expect((await request(app).post('/things/a/actions/rename').send({ to: 'b' })).status).toBe(200);
    });

    it('requires authentication only for an op declared with []', async () => {
      const { app } = buildApp(handler, secured, { authExtractor: byHeader });

      expect((await request(app).get('/things/a')).status).toBe(401);
      expect((await request(app).get('/things/a').set('x-scopes', '')).status).toBe(200);
    });

    it('checks the scope before validating the body', async () => {
      const { app } = buildApp(handler, secured, { authExtractor: byHeader });

      const anonymous = await request(app).post('/things').send({ bogus: 1 });
      const wrongScope = await request(app).post('/things').set('x-scopes', 'things:read').send({ bogus: 1 });
      const allowed = await request(app).post('/things').set('x-scopes', 'things:write').send({ name: 'n' });

      expect(anonymous.status).toBe(401);
      expectProblem(wrongScope, 403, 'Forbidden', 'missing required scope: things:write', '/things');
      expect(allowed.status).toBe(201);
      expect(allowed.body).toEqual({ slug: 'new', name: 'n' });
    });

    it('guards actions by their own scope list', async () => {
      const { app } = buildApp(handler, secured, { authExtractor: byHeader });

      const wrongScope = await request(app)
        .post('/things/a/actions/archive')
        .set('x-scopes', 'things:write');
      const allowed = await request(app)
        .post('/things/a/actions/archive')
        .set('x-scopes', 'things:write,things:admin');

      expectProblem(
        wrongScope,
        403,
        'Forbidden',
        'missing required scope: things:admin',
        '/things/a/actions/archive'
      );
      expect(allowed.status).toBe(200);
      expect(allowed.body).toEqual({ done: true });
    });
  });
});
