import { addAction } from './registry';
import { ActionSpec, FieldSpec } from './types';

export interface ActionOpts {
  description?: string;
  stateField?: string;
  from?: string;
  to?: string;
  input?: FieldSpec[];
  transactional?: boolean;
}

export function action(name: string, opts: ActionOpts = {}): MethodDecorator {
  return (target, propertyKey) => {
    // Static methods put the constructor itself in `target` (so
    // `target.constructor === Function`), which would register the action
    // under the global Function key in the registry — silently corrupting
    // every other class's spec. The IR has no concept of a static action, so
    // reject it outright rather than registering it somewhere meaningless.
    if (typeof target === 'function') {
      throw new Error(
        `@action must decorate an instance method (got static method "${String(propertyKey)}")`,
      );
    }
    const spec: ActionSpec = { name };
    if (opts.description !== undefined) spec.description = opts.description;
    if (opts.from !== undefined || opts.to !== undefined) {
      spec.stateField = opts.stateField ?? 'status';
      // Only assign when defined: an unconditional assignment creates a
      // phantom own-property (visible to Object.keys/deep-equality) even
      // when the caller never passed `from`/`to`.
      if (opts.from !== undefined) spec.from = opts.from;
      if (opts.to !== undefined) spec.to = opts.to;
    }
    if (opts.input && opts.input.length > 0) spec.input = opts.input;
    if (opts.transactional === false) spec.transactional = false;
    addAction(target.constructor, spec);
  };
}
