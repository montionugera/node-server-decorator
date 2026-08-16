import { EntitySpec, FieldSpec } from '@montionugera/entity-spec';
import { JsonSchema, jsonSchemaForField } from './map-field';
import { capitalize } from './components';

const problem = (status: string, description: string, component = 'Problem') => ({
  [status]: {
    description,
    content: {
      'application/problem+json': { schema: { $ref: `#/components/schemas/${component}` } },
    },
  },
});

const json = (ref: string) => ({
  content: { 'application/json': { schema: { $ref: `#/components/schemas/${ref}` } } },
});

function idField(spec: EntitySpec): FieldSpec {
  const f = spec.fields.find((x) => x.role === 'id');
  if (!f) throw new Error(`${spec.entity}: no field with role "id"`);
  return f;
}

function securityFor(spec: EntitySpec, key: string, kind: 'ops' | 'actions'): JsonSchema | null {
  const scopes = spec.security?.[kind]?.[key];
  if (scopes === undefined) return null;
  const scheme = spec.security?.schemes[0];
  if (!scheme) return null;
  return { security: [{ [scheme.name]: scopes }] };
}

function filterParams(spec: EntitySpec): JsonSchema[] {
  return spec.fields
    .filter((f) => f.filterable)
    .map((f) => {
      const { optional: _o, nullable: _n, ...rest } = f;
      return { name: f.name, in: 'query', required: false, schema: jsonSchemaForField(rest) };
    });
}

function paginationParams(spec: EntitySpec): JsonSchema[] {
  const limit = {
    name: 'limit', in: 'query', required: false,
    schema: { type: 'integer', minimum: 1, maximum: 100, default: 20 },
  };
  if (spec.pagination === 'cursor') {
    return [limit, { name: 'cursor', in: 'query', required: false, schema: { type: 'string' } }];
  }
  return [
    limit,
    { name: 'offset', in: 'query', required: false,
      schema: { type: 'integer', minimum: 0, default: 0 } },
  ];
}

export function openapiPaths(spec: EntitySpec): Record<string, JsonSchema> {
  const e = spec.entity;
  const base = `/${spec.path}`;
  const id = idField(spec);
  const idParam = {
    name: id.name, in: 'path', required: true, schema: jsonSchemaForField({ ...id, role: undefined }),
  };
  const tags = spec.tags ? { tags: spec.tags } : {};
  const out: Record<string, JsonSchema> = {};
  const collection: Record<string, unknown> = {};
  const item: Record<string, unknown> = {};

  if (spec.ops.includes('list')) {
    const params = [...paginationParams(spec), ...filterParams(spec)]
      .sort((a, b) => String(a.name).localeCompare(String(b.name)));
    collection.get = {
      ...tags, operationId: `list${e}`, parameters: params,
      responses: {
        '200': { description: 'OK', ...json(`${e}ListResponse`) },
        ...(filterParams(spec).length > 0
          ? problem('400', 'Bad Request', 'ValidationProblem') : {}),
      },
      ...(securityFor(spec, 'list', 'ops') ?? {}),
    };
  }
  if (spec.ops.includes('create')) {
    collection.post = {
      ...tags, operationId: `create${e}`,
      requestBody: { required: true, ...json(`${e}Create`) },
      responses: {
        '201': { description: 'Created', ...json(`${e}Read`) },
        ...problem('400', 'Bad Request', 'ValidationProblem'),
      },
      ...(securityFor(spec, 'create', 'ops') ?? {}),
    };
  }
  if (spec.ops.includes('get')) {
    item.get = {
      ...tags, operationId: `get${e}`, parameters: [idParam],
      responses: { '200': { description: 'OK', ...json(`${e}Read`) }, ...problem('404', 'Not Found') },
      ...(securityFor(spec, 'get', 'ops') ?? {}),
    };
  }
  if (spec.ops.includes('update')) {
    item.patch = {
      ...tags, operationId: `update${e}`, parameters: [idParam],
      requestBody: { required: true, ...json(`${e}Update`) },
      responses: {
        '200': { description: 'OK', ...json(`${e}Read`) },
        ...problem('400', 'Bad Request', 'ValidationProblem'),
        ...problem('404', 'Not Found'),
      },
      ...(securityFor(spec, 'update', 'ops') ?? {}),
    };
  }
  if (spec.ops.includes('delete')) {
    item.delete = {
      ...tags, operationId: `delete${e}`, parameters: [idParam],
      responses: { '204': { description: 'No Content' }, ...problem('404', 'Not Found') },
      ...(securityFor(spec, 'delete', 'ops') ?? {}),
    };
  }
  if (Object.keys(collection).length > 0) out[base] = collection;
  if (Object.keys(item).length > 0) out[`${base}/{${id.name}}`] = item;

  for (const a of spec.actions ?? []) {
    out[`${base}/{${id.name}}/actions/${a.name}`] = {
      post: {
        ...tags, operationId: `${a.name}${e}`, parameters: [idParam],
        ...(a.description !== undefined ? { description: a.description } : {}),
        requestBody: { required: true, ...json(`${e}${capitalize(a.name)}Input`) },
        responses: {
          '200': { description: 'OK', ...json(`${e}Read`) },
          ...problem('400', 'Bad Request', 'ValidationProblem'),
          ...problem('404', 'Not Found'),
          ...(a.from !== undefined ? problem('409', 'Conflict') : {}),
        },
        ...(securityFor(spec, a.name, 'actions') ?? {}),
      },
    };
  }
  return out;
}
