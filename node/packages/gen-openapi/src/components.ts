import { EntitySpec, FieldSpec, SecurityScheme } from '@montionugera/entity-spec';
import { JsonSchema, objectProperties } from './map-field';

export function capitalize(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

function strictObject(fields: FieldSpec[], include: (f: FieldSpec) => boolean): JsonSchema {
  const kept = fields.filter(include);
  const s: JsonSchema = { type: 'object', properties: objectProperties(kept, include) };
  const required = kept.filter((f) => !f.optional).map((f) => f.name);
  if (required.length > 0) s.required = required;
  s.additionalProperties = false;
  return s;
}

function listEnvelope(entity: string, pagination: 'offset' | 'cursor'): JsonSchema {
  const items = { type: 'array', items: { $ref: `#/components/schemas/${entity}Read` } };
  const limit = { type: 'integer', minimum: 1, maximum: 100 };
  if (pagination === 'cursor') {
    return {
      type: 'object',
      properties: { items, nextCursor: { type: ['string', 'null'] } },
      required: ['items', 'nextCursor'],
      additionalProperties: false,
    };
  }
  return {
    type: 'object',
    properties: {
      items,
      total: { type: 'integer', minimum: 0 },
      limit,
      offset: { type: 'integer', minimum: 0 },
    },
    required: ['items', 'total', 'limit', 'offset'],
    additionalProperties: false,
  };
}

export const PROBLEM_SCHEMAS: Record<string, JsonSchema> = {
  Problem: {
    type: 'object',
    properties: {
      type: { type: 'string', format: 'uri' },
      title: { type: 'string' },
      status: { type: 'integer' },
      detail: { type: 'string' },
      instance: { type: 'string', format: 'uri' },
    },
    required: ['type', 'title', 'status'],
    additionalProperties: false,
  },
  ValidationProblem: {
    type: 'object',
    properties: {
      type: { type: 'string', format: 'uri' },
      title: { type: 'string' },
      status: { type: 'integer' },
      detail: { type: 'string' },
      instance: { type: 'string', format: 'uri' },
      fields: { type: 'array', items: { type: 'string' } },
    },
    required: ['type', 'title', 'status', 'fields'],
    additionalProperties: false,
  },
};

function schemeObject(s: SecurityScheme): JsonSchema {
  if (s.type === 'apiKey') {
    return { type: 'apiKey', in: s.in, name: s.paramName };
  }
  const out: JsonSchema = { type: 'http', scheme: s.scheme };
  if (s.bearerFormat !== undefined) out.bearerFormat = s.bearerFormat;
  return out;
}

export function openapiComponents(spec: EntitySpec): {
  schemas: Record<string, JsonSchema>;
  securitySchemes: Record<string, JsonSchema>;
} {
  const e = spec.entity;
  const create = strictObject(spec.fields, (f) => !f.readonly);
  const update = { ...create };
  delete (update as { required?: unknown }).required;

  const schemas: Record<string, JsonSchema> = {
    [`${e}Create`]: create,
    [`${e}Update`]: update,
    [`${e}Read`]: strictObject(spec.fields, (f) => !f.writeonly),
    [`${e}ListResponse`]: listEnvelope(e, spec.pagination),
  };
  for (const a of spec.actions ?? []) {
    schemas[`${e}${capitalize(a.name)}Input`] = strictObject(a.input ?? [], () => true);
  }

  const securitySchemes: Record<string, JsonSchema> = {};
  for (const s of spec.security?.schemes ?? []) {
    securitySchemes[s.name] = schemeObject(s);
  }
  return { schemas, securitySchemes };
}
