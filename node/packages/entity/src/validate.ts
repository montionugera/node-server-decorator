import { ActionSpec, FieldSpec } from './types';

// Public pydantic.BaseModel attribute names (pydantic v2) — see
// contracts/rules/entity-spec-validation.md "Reserved wire names" for how this list is derived
// and kept in sync with the Python twin (server_decorator_entity.validate.RESERVED_WIRE_NAMES).
export const RESERVED_WIRE_NAMES: ReadonlySet<string> = new Set([
  'construct',
  'copy',
  'dict',
  'from_orm',
  'json',
  'model_computed_fields',
  'model_config',
  'model_construct',
  'model_copy',
  'model_dump',
  'model_dump_json',
  'model_extra',
  'model_fields',
  'model_fields_set',
  'model_json_schema',
  'model_parametrized_name',
  'model_post_init',
  'model_rebuild',
  'model_validate',
  'model_validate_json',
  'model_validate_strings',
  'parse_file',
  'parse_obj',
  'parse_raw',
  'schema',
  'schema_json',
  'update_forward_refs',
  'validate',
]);

function assertIntegerOrUndefined(value: number | undefined, label: string): void {
  if (value !== undefined && !Number.isInteger(value)) {
    throw new Error(`${label}: min/max must be integers (got ${value})`);
  }
}

export function validateField(f: FieldSpec, path: string): void {
  const label = `field "${path}"`;
  if (RESERVED_WIRE_NAMES.has(f.name)) {
    throw new Error(
      `${label}: wire name "${f.name}" is reserved (shadows a pydantic BaseModel attribute)`,
    );
  }
  if (f.format !== undefined && f.pattern !== undefined) {
    throw new Error(`${label}: format and pattern are mutually exclusive`);
  }
  if (f.enum !== undefined && f.enum.length === 0) {
    throw new Error(`${label}: enum must have at least one value`);
  }
  assertIntegerOrUndefined(f.min, `${label}.min`);
  assertIntegerOrUndefined(f.max, `${label}.max`);
  if (f.item) validateField(f.item, `${path}.item`);
  if (f.fields) for (const nested of f.fields) validateField(nested, `${path}.${nested.name}`);
}

export interface ValidatableEntitySpec {
  entity: string;
  transports: unknown[];
  ops: unknown[];
  fields: FieldSpec[];
  actions?: ActionSpec[];
}

export function validateEntitySpec(spec: ValidatableEntitySpec): void {
  if (spec.transports.length === 0) {
    throw new Error(`${spec.entity}: transports must not be empty`);
  }
  if (spec.ops.length === 0) {
    throw new Error(`${spec.entity}: ops must not be empty`);
  }
  for (const f of spec.fields) validateField(f, f.name);
  if (spec.actions) {
    for (const a of spec.actions) {
      for (const f of a.input ?? []) validateField(f, `${a.name}.${f.name}`);
    }
  }
}
