import { addAction } from './registry';
import { ActionSpec, FieldSpec } from './types';

export interface ActionOpts {
  stateField?: string;
  from?: string;
  to?: string;
  input?: FieldSpec[];
  transactional?: boolean;
}

export function action(name: string, opts: ActionOpts = {}): MethodDecorator {
  return (target) => {
    const spec: ActionSpec = { name };
    if (opts.from !== undefined || opts.to !== undefined) {
      spec.stateField = opts.stateField ?? 'status';
      spec.from = opts.from;
      spec.to = opts.to;
    }
    if (opts.input && opts.input.length > 0) spec.input = opts.input;
    if (opts.transactional === false) spec.transactional = false;
    addAction(target.constructor, spec);
  };
}
