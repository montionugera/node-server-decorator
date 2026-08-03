import { canonicalJson } from './canonical';
import { specFor } from './registry';
import { EntitySpec, Op, Transport } from './types';

export interface RestfulOpts {
  path: string;
  transports?: Transport[];
  ops?: Op[];
  pagination?: 'offset' | 'cursor';
}

const finalized = new WeakMap<Function, EntitySpec>();

export function Restful(opts: RestfulOpts): ClassDecorator {
  return (ctor) => {
    const draft = specFor(ctor);
    const spec: EntitySpec = {
      specVersion: '1.1.0',
      entity: ctor.name,
      path: opts.path,
      transports: opts.transports ?? ['rest'],
      ops: opts.ops ?? ['list', 'get', 'create', 'update', 'delete'],
      pagination: opts.pagination ?? 'offset',
      fields: draft.fields,
      ...(draft.actions.length > 0 ? { actions: draft.actions } : {}),
    };
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
