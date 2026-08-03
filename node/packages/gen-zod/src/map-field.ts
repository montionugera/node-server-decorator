import { z } from 'zod';
import { FieldSpec } from '@montionugera/entity-spec';

// WHATWG HTML5 email pattern — see contracts/rules/entity-spec-validation.md. Both gen-zod
// and gen-pydantic MUST validate `format: "email"` against this exact regex (not either
// ecosystem's built-in email validator, which diverge from each other: pydantic's `EmailStr`
// accepts `a@b.c`, zod's `.email()` rejects it). Exported so adapters can reuse it directly.
export const EMAIL_PATTERN =
  /^[a-zA-Z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?(?:\.[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?)*$/;

export function zodForField(f: FieldSpec, include: (f: FieldSpec) => boolean = () => true): z.ZodTypeAny {
  let s: z.ZodTypeAny;
  switch (f.type) {
    case 'str': {
      let str = z.string();
      if (f.format === 'email') str = str.regex(EMAIL_PATTERN);
      if (f.format === 'uuid') str = str.uuid();
      if (f.format === 'uri') str = str.url();
      if (f.min !== undefined) str = str.min(f.min);
      if (f.max !== undefined) str = str.max(f.max);
      if (f.pattern !== undefined) str = str.regex(new RegExp(f.pattern));
      s = str;
      break;
    }
    case 'int': {
      let n = z.number().int();
      if (f.min !== undefined) n = n.gte(f.min);
      if (f.max !== undefined) n = n.lte(f.max);
      s = n;
      break;
    }
    case 'float': {
      let n = z.number();
      if (f.min !== undefined) n = n.gte(f.min);
      if (f.max !== undefined) n = n.lte(f.max);
      s = n;
      break;
    }
    case 'bool': s = z.boolean(); break;
    case 'datetime': s = z.string().datetime({ offset: true }); break;
    case 'enum': s = z.enum(f.enum as [string, ...string[]]); break;
    case 'ref': s = z.string(); break;
    case 'list': s = z.array(zodForField(f.item as FieldSpec, include)); break;
    case 'obj': s = strictObject(f.fields ?? [], include); break;
  }
  if (f.nullable) s = s.nullable();
  if (f.optional) s = s.optional();
  return s;
}

export function strictObject(fields: FieldSpec[], include: (f: FieldSpec) => boolean): z.ZodTypeAny {
  const shape: Record<string, z.ZodTypeAny> = {};
  for (const f of fields) if (include(f)) shape[f.name] = zodForField(f, include);
  return z.object(shape).strict();
}
