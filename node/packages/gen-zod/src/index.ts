import { z } from 'zod';
import { ActionSpec, EntitySpec, FieldSpec } from '@montionugera/entity-spec';
import { strictObject } from './map-field';

export { zodForField } from './map-field';

export function createSchema(spec: EntitySpec): z.ZodTypeAny {
  return strictObject(spec.fields, (f) => !f.readonly);
}

export function updateSchema(spec: EntitySpec): z.ZodTypeAny {
  return (createSchema(spec) as z.ZodObject<z.ZodRawShape>).partial();
}

export function readSchema(spec: EntitySpec): z.ZodTypeAny {
  return strictObject(spec.fields, (f) => !f.writeonly);
}

export function actionInputSchema(spec: EntitySpec, actionName: string): z.ZodTypeAny {
  const action: ActionSpec | undefined = spec.actions?.find((a) => a.name === actionName);
  if (!action) throw new Error(`Unknown action "${actionName}" on entity ${spec.entity}`);
  return strictObject(action.input ?? [], () => true);
}

export function validationErrorFields(error: z.ZodError): string[] {
  const fields = new Set<string>();
  for (const issue of error.issues) {
    if (issue.code === 'unrecognized_keys') {
      for (const k of issue.keys) fields.add([...issue.path, k].join('.'));
    } else {
      fields.add(issue.path.join('.'));
    }
  }
  return [...fields].sort();
}
