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

// `include` threads through EVERY level of nesting — obj members and list items alike —
// because contracts/rules/rest-conventions.md filters nested obj and list members by the same
// rule as their parent, and gen-zod's zodForField already does exactly this. Without it a
// create DTO would keep a readonly member that lives inside a list of objects.
export function jsonSchemaForField(
  f: FieldSpec,
  include: (f: FieldSpec) => boolean = () => true,
): JsonSchema {
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
    s.items = f.item ? jsonSchemaForField(f.item, include) : {};
    if (f.min !== undefined) s.minItems = f.min;
    if (f.max !== undefined) s.maxItems = f.max;
  }
  if (f.type === 'obj') {
    const kept = (f.fields ?? []).filter(include);
    s.properties = objectProperties(kept, include);
    // Filter `required` by `include` too: an excluded member left in `required` would make the
    // schema impossible to satisfy, since its property is not emitted at all.
    const required = kept.filter((n) => !n.optional).map((n) => n.name);
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
    out[f.name] = jsonSchemaForField(f, include);
  }
  return out;
}
