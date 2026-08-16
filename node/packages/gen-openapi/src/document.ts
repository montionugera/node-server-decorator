import { EntitySpec } from '@montionugera/entity-spec';
import { JsonSchema } from './map-field';
import { PROBLEM_SCHEMAS, openapiComponents } from './components';
import { openapiPaths } from './paths';

export function openapiDocument(specs: EntitySpec[], version: string): JsonSchema {
  const schemas: Record<string, JsonSchema> = { ...PROBLEM_SCHEMAS };
  const securitySchemes: Record<string, JsonSchema> = {};
  const paths: Record<string, JsonSchema> = {};
  const tagNames = new Set<string>();

  for (const spec of specs) {
    const c = openapiComponents(spec);
    Object.assign(schemas, c.schemas);
    Object.assign(securitySchemes, c.securitySchemes);
    Object.assign(paths, openapiPaths(spec));
    for (const t of spec.tags ?? []) tagNames.add(t);
  }

  const doc: JsonSchema = {
    openapi: '3.1.0',
    info: { title: 'server-decorator API', version },
    paths,
    components: { schemas },
  };
  if (tagNames.size > 0) {
    doc.tags = [...tagNames].sort().map((name) => ({ name }));
  }
  if (Object.keys(securitySchemes).length > 0) {
    (doc.components as Record<string, unknown>).securitySchemes = securitySchemes;
  }
  return doc;
}
