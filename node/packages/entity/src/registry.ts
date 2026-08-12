import { ActionSpec, FieldSpec, MutableEntitySpec } from './types';

const registry = new WeakMap<Function, MutableEntitySpec>();

export function specFor(ctor: Function): MutableEntitySpec {
  let spec = registry.get(ctor);
  if (!spec) {
    spec = { fields: [], actions: [] };
    registry.set(ctor, spec);
  }
  return spec;
}

export function addField(ctor: Function, field: FieldSpec): void {
  specFor(ctor).fields.push(field);
}

export function addAction(ctor: Function, action: ActionSpec): void {
  specFor(ctor).actions.push(action);
}
