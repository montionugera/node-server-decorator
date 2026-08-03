import { z } from 'zod';
import { FieldSpec } from '@montionugera/entity-spec';

export function zodForField(f: FieldSpec): z.ZodTypeAny {
  let s: z.ZodTypeAny;
  switch (f.type) {
    case 'str': {
      let str = z.string();
      if (f.format === 'email') str = str.email();
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
    case 'list': s = z.array(zodForField(f.item as FieldSpec)); break;
    case 'obj': s = strictObject(f.fields ?? [], () => true); break;
  }
  if (f.nullable) s = s.nullable();
  if (f.optional) s = s.optional();
  return s;
}

export function strictObject(fields: FieldSpec[], include: (f: FieldSpec) => boolean): z.ZodTypeAny {
  const shape: Record<string, z.ZodTypeAny> = {};
  for (const f of fields) if (include(f)) shape[f.name] = zodForField(f);
  return z.object(shape).strict();
}
