import { canonicalJson } from './canonical';
import { specFor } from './registry';
import { EntitySpec, FieldSpec, Op, SecuritySpec, Transport } from './types';
import { validateEntitySpec } from './validate';

export interface RestfulOpts {
  path: string;
  transports?: Transport[];
  ops?: Op[];
  pagination?: 'offset' | 'cursor';
  description?: string;
  tags?: string[];
  security?: SecuritySpec;
}

const finalized = new WeakMap<Function, EntitySpec>();

// entitySpec() memoizes on the constructor, so every caller shares the same
// spec object. Without a deep freeze, `entitySpec(X).fields.push(...)` (or
// mutating a returned field/action object) permanently corrupts the memoized
// spec for every subsequent caller. Freeze recursively, bottom-up, so nested
// item/fields arrays and objects are locked before their parents are.
function deepFreezeField(f: FieldSpec): FieldSpec {
  if (f.item) deepFreezeField(f.item);
  if (f.fields) {
    f.fields.forEach(deepFreezeField);
    Object.freeze(f.fields);
  }
  return Object.freeze(f);
}

export function Restful(opts: RestfulOpts): ClassDecorator {
  return (ctor) => {
    const draft = specFor(ctor);
    const spec: EntitySpec = {
      specVersion: '1.2.0',
      entity: ctor.name,
      path: opts.path,
      // `??` is null-coalescing, not empty-coalescing — an explicit `transports: []`/`ops: []`
      // must pass through here (not be silently replaced by the default) so validateEntitySpec
      // below can fail fast on it, rather than either defaulting it away or emitting
      // schema-invalid empty-array IR (C4).
      transports: opts.transports ?? ['rest'],
      ops: opts.ops ?? ['list', 'get', 'create', 'update', 'delete'],
      pagination: opts.pagination ?? 'offset',
      // Keep absent keys absent so canonical JSON is byte-unchanged for 1.1-era declarations.
      ...(opts.description !== undefined ? { description: opts.description } : {}),
      ...(opts.tags !== undefined ? { tags: opts.tags } : {}),
      ...(opts.security !== undefined ? { security: opts.security } : {}),
      fields: draft.fields,
      ...(draft.actions.length > 0 ? { actions: draft.actions } : {}),
    };
    validateEntitySpec(spec);
    spec.fields.forEach(deepFreezeField);
    Object.freeze(spec.fields);
    if (spec.actions) {
      spec.actions.forEach((a) => Object.freeze(a));
      Object.freeze(spec.actions);
    }
    finalized.set(ctor, Object.freeze(spec));
  };
}

export function entitySpec(ctor: Function): EntitySpec {
  const spec = finalized.get(ctor);
  if (!spec) throw new Error(`${ctor.name} is not decorated with @Restful`);
  return spec;
}

export function entitySpecCanonical(ctor: Function): string {
  return canonicalJson(entitySpec(ctor));
}
