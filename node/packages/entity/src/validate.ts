import { ActionSpec, FieldSpec, SecuritySpec } from './types';

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

// A `\` run of odd length immediately before a digit 1-9 means that digit is escaped — a
// backreference (`\1`). An even-length run means the backslashes are themselves escaped
// (`\\1` is a literal backslash followed by the literal digit `1`), so it's NOT a backreference.
// `\0` is never a backreference (it's either a literal `0` or, in some engines, a null escape —
// not a capture-group reference), so only digits 1-9 are scanned. This is a conservative lexical
// scan, not a regex parser — see contracts/rules/entity-spec-validation.md for what it does and
// does not catch.
function hasBackreference(pattern: string): boolean {
  for (let i = 0; i < pattern.length; i++) {
    const c = pattern[i];
    if (c >= '1' && c <= '9') {
      let backslashes = 0;
      let j = i - 1;
      while (j >= 0 && pattern[j] === '\\') {
        backslashes++;
        j--;
      }
      if (backslashes % 2 === 1) return true;
    }
  }
  return false;
}

const LOOKAROUND_MARKERS = ['(?=', '(?!', '(?<=', '(?<!'];

// pydantic v2's Rust-backed regex engine (used by gen-pydantic) does not support lookaround or
// backreferences — both are valid JS RegExp / Python `re` syntax, so a pattern using either
// builds fine in gen-zod but crashes gen-pydantic's entire model build. Reject non-portable
// patterns at DECORATION time (before either generator ever sees the IR) rather than leaving it
// to the generator to crash — see contracts/rules/entity-spec-validation.md.
function assertPortablePattern(pattern: string | undefined, label: string): void {
  if (pattern === undefined) return;
  const lookaround = LOOKAROUND_MARKERS.find((m) => pattern.includes(m));
  if (lookaround !== undefined) {
    throw new Error(
      `${label}: pattern ${JSON.stringify(pattern)} is not RE2/rust-regex compatible ` +
        `(contains lookaround "${lookaround}") — see contracts/rules/entity-spec-validation.md`,
    );
  }
  if (hasBackreference(pattern)) {
    throw new Error(
      `${label}: pattern ${JSON.stringify(pattern)} is not RE2/rust-regex compatible ` +
        `(contains a backreference) — see contracts/rules/entity-spec-validation.md`,
    );
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
  assertPortablePattern(f.pattern, label);
  if (f.enum !== undefined && f.enum.length === 0) {
    throw new Error(`${label}: enum must have at least one value`);
  }
  assertIntegerOrUndefined(f.min, `${label}.min`);
  assertIntegerOrUndefined(f.max, `${label}.max`);
  if (f.item) validateField(f.item, `${path}.item`);
  if (f.fields) for (const nested of f.fields) validateField(nested, `${path}.${nested.name}`);
}

export function validateSecurity(
  security: SecuritySpec | undefined,
  ops: unknown[],
  actionNames: string[],
  entity: string,
): void {
  if (!security) return;
  if (security.schemes.length === 0) {
    throw new Error(`${entity}: security.schemes must not be empty`);
  }
  for (const s of security.schemes) {
    if (s.type !== 'http' && s.type !== 'apiKey') {
      throw new Error(`${entity}: scheme "${s.name}": type must be "http" or "apiKey"`);
    }
    if (s.type === 'http' && s.scheme === undefined) {
      throw new Error(`${entity}: scheme "${s.name}": http requires "scheme"`);
    }
    if (s.type === 'apiKey' && (s.in === undefined || s.paramName === undefined)) {
      throw new Error(`${entity}: scheme "${s.name}": apiKey requires "in" and "paramName"`);
    }
  }
  for (const op of Object.keys(security.ops ?? {})) {
    if (!ops.includes(op)) {
      throw new Error(`${entity}: security.ops.${op} is not declared in ops`);
    }
  }
  for (const name of Object.keys(security.actions ?? {})) {
    if (!actionNames.includes(name)) {
      throw new Error(`${entity}: security.actions.${name} is not a declared action`);
    }
  }
}

export interface ValidatableEntitySpec {
  entity: string;
  transports: unknown[];
  ops: unknown[];
  fields: FieldSpec[];
  actions?: ActionSpec[];
  security?: SecuritySpec;
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
  validateSecurity(spec.security, spec.ops, (spec.actions ?? []).map((a) => a.name), spec.entity);
}
