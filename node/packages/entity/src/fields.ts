import { addField } from './registry';
import { FieldSpec } from './types';

type FieldOpts = Partial<Omit<FieldSpec, 'name'>>;

// Inject the field's own name into `item.name` at EVERY nesting level of a list-of-list(-of-list…),
// not just one level deep — matches Python's FieldMarker.to_ir, which passes the same `name` down
// through every recursive `self.item.to_ir(name)` call. A list item has no meaningful name of its
// own (it's a single anonymous value slot), so this always overwrites rather than only filling in
// an empty string.
function injectListItemNames(f: FieldSpec, name: string): FieldSpec {
  if (f.type !== 'list' || !f.item) return f;
  return { ...f, item: { ...injectListItemNames(f.item, name), name } };
}

export function field(def: FieldOpts & { type: FieldSpec['type'] }): PropertyDecorator {
  return (target, propertyKey) => {
    const raw: FieldSpec = { name: String(propertyKey), ...def } as FieldSpec;
    const f = raw.type === 'list' ? injectListItemNames(raw, raw.name) : raw;
    addField(target.constructor, f);
  };
}

type Flags = Pick<FieldSpec, 'optional' | 'nullable' | 'readonly' | 'writeonly' | 'filterable'>;
type StrOpts = Flags & Pick<FieldSpec, 'min' | 'max' | 'pattern' | 'format'>;
type NumOpts = Flags & Pick<FieldSpec, 'min' | 'max'>;

export const id = () => field({ type: 'str', role: 'id', readonly: true });
export const str = (o: StrOpts = {}) => field({ type: 'str', ...o });
export const email = (o: Flags = {}) => field({ type: 'str', format: 'email', ...o });
export const uuid = (o: Flags = {}) => field({ type: 'str', format: 'uuid', ...o });
export const uri = (o: Flags = {}) => field({ type: 'str', format: 'uri', ...o });
export const int = (o: NumOpts = {}) => field({ type: 'int', ...o });
export const float = (o: NumOpts = {}) => field({ type: 'float', ...o });
export const bool = (o: Flags = {}) => field({ type: 'bool', ...o });
export const datetime = (o: Flags = {}) => field({ type: 'datetime', ...o });
export const enumOf = (values: string[], o: Flags = {}) => field({ type: 'enum', enum: values, ...o });
export const ref = (entity: string, o: Flags = {}) => field({ type: 'ref', ref: entity, ...o });

// item/fields take the same shape minus `name` (the builder injects it).
export const listOf = (item: FieldOpts & { type: FieldSpec['type'] }, o: Flags = {}) =>
  field({ type: 'list', item: { name: '', ...item } as FieldSpec, ...o });
export const obj = (fields: Array<FieldSpec>, o: Flags = {}) =>
  field({ type: 'obj', fields, ...o });
