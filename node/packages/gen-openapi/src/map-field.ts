import { FieldSpec } from '@montionugera/entity-spec';
import { EMAIL_PATTERN, UUID_PATTERN, URI_PATTERN } from './patterns';

export type JsonSchema = Record<string, unknown>;

const BASE_TYPE: Record<string, string> = {
  str: 'string', ref: 'string', int: 'integer', float: 'number',
  bool: 'boolean', datetime: 'string', enum: 'string', list: 'array', obj: 'object',
};

const FORMAT_PATTERN: Record<string, RegExp> = {
  email: EMAIL_PATTERN, uuid: UUID_PATTERN, uri: URI_PATTERN,
};

export function jsonSchemaForField(f: FieldSpec): JsonSchema {
  const base = BASE_TYPE[f.type];
  const s: JsonSchema = { type: f.nullable ? [base, 'null'] : base };

  if (f.type === 'datetime') s.format = 'date-time';
  if (f.type === 'str' || f.type === 'ref') {
    if (f.format) {
      s.format = f.format;
      s.pattern = FORMAT_PATTERN[f.format].source;
    }
    if (f.pattern !== undefined) s.pattern = f.pattern;
    if (f.min !== undefined) s.minLength = f.min;
    if (f.max !== undefined) s.maxLength = f.max;
  }
  if (f.type === 'int' || f.type === 'float') {
    if (f.min !== undefined) s.minimum = f.min;
    if (f.max !== undefined) s.maximum = f.max;
  }
  if (f.type === 'enum' && f.enum) s.enum = [...f.enum];
  if (f.type === 'list') {
    s.items = f.item ? jsonSchemaForField(f.item) : {};
    if (f.min !== undefined) s.minItems = f.min;
    if (f.max !== undefined) s.maxItems = f.max;
  }
  if (f.type === 'obj') {
    s.properties = objectProperties(f.fields ?? [], () => true);
    const required = (f.fields ?? []).filter((n) => !n.optional).map((n) => n.name);
    if (required.length > 0) s.required = required;
    s.additionalProperties = false;
  }
  if (f.description !== undefined) s.description = f.description;
  return s;
}

export function objectProperties(
  fields: FieldSpec[],
  include: (f: FieldSpec) => boolean,
): Record<string, JsonSchema> {
  const out: Record<string, JsonSchema> = {};
  for (const f of fields.filter(include)) {
    const nested: FieldSpec =
      f.type === 'obj' && f.fields ? { ...f, fields: f.fields.filter(include) } : f;
    out[f.name] = jsonSchemaForField(nested);
  }
  return out;
}
