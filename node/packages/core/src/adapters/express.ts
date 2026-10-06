import { ScopeExtractor, checkScopes } from '../middleware/scope-auth';

export const PROBLEM_CONTENT_TYPE = 'application/problem+json';
export const VALIDATION_PROBLEM_TYPE = 'https://server-decorator.dev/errors/validation';

export const EMAIL_PATTERN =
  /^[a-zA-Z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?(?:\.[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?)*$/;
export const UUID_PATTERN =
  /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;
export const URI_PATTERN = /^[a-zA-Z][a-zA-Z0-9+.-]*:\/\/[^\s]+$/;

export class NotFoundError extends Error {
  readonly status = 404;
  readonly statusCode = 404;
  constructor(message?: string) {
    super(message || 'Not Found');
    this.name = 'NotFoundError';
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

export interface ProblemDetails {
  type: string;
  title: string;
  status: number;
  detail?: string;
  instance?: string;
  [key: string]: any;
}

export interface ValidationProblemDetails extends ProblemDetails {
  fields: string[];
}

export function writeProblem(
  res: any,
  status: number,
  title?: string,
  detail?: string,
  instance?: string
): void {
  const defaultTitles: Record<number, string> = {
    400: 'Bad Request',
    401: 'Unauthorized',
    403: 'Forbidden',
    404: 'Not Found',
    500: 'Internal Server Error',
  };
  const body: ProblemDetails = {
    type: 'about:blank',
    title: title || defaultTitles[status] || 'Error',
    status,
    ...(detail !== undefined ? { detail } : {}),
    ...(instance !== undefined ? { instance } : {}),
  };
  res.status(status).setHeader('Content-Type', PROBLEM_CONTENT_TYPE).json(body);
}

export function writeValidationProblem(
  res: any,
  fields: string[],
  instance?: string
): void {
  const body: ValidationProblemDetails = {
    type: VALIDATION_PROBLEM_TYPE,
    title: 'Validation Failed',
    status: 400,
    fields: fields || [],
    ...(instance !== undefined ? { instance } : {}),
  };
  res.status(400).setHeader('Content-Type', PROBLEM_CONTENT_TYPE).json(body);
}

export interface ListParams {
  limit: number;
  offset: number;
  filters: Record<string, string>;
}

export interface ListResult<T = any> {
  items: T[];
  total: number;
}

export interface EntityHandler<T = any> {
  list(params: ListParams): Promise<ListResult<T>>;
  get(id: string): Promise<T | null | undefined>;
  create(data: Record<string, any>): Promise<T>;
  update(id: string, data: Record<string, any>): Promise<T | null | undefined>;
  delete(id: string): Promise<void>;
  action?(id: string, actionName: string, data: Record<string, any>): Promise<any>;
}

export interface ExpressAdapterOptions {
  authExtractor?: ScopeExtractor;
}

export interface FieldSpec {
  name: string;
  type: 'str' | 'int' | 'float' | 'bool' | 'datetime' | 'enum' | 'ref' | 'list' | 'obj';
  description?: string;
  role?: 'id';
  format?: 'email' | 'uuid' | 'uri';
  enum?: string[];
  min?: number;
  max?: number;
  pattern?: string;
  optional?: true | boolean;
  nullable?: true | boolean;
  readonly?: true | boolean;
  writeonly?: true | boolean;
  filterable?: true | boolean;
  item?: FieldSpec;
  ref?: string;
  fields?: FieldSpec[];
}

export interface ActionSpec {
  name: string;
  description?: string;
  input?: FieldSpec[];
}

export interface SecuritySpec {
  schemes?: any[];
  ops?: Record<string, string[]>;
  actions?: Record<string, string[]>;
}

export interface EntitySpec {
  specVersion?: string;
  entity: string;
  path: string;
  transports?: string[];
  ops: string[];
  pagination?: string;
  fields: FieldSpec[];
  actions?: ActionSpec[];
  security?: SecuritySpec;
}

function hasExplicitUtcOffset(s: string): boolean {
  if (s.endsWith('Z') || s.endsWith('z')) return true;
  if (s.length >= 6) {
    const tail = s.slice(-6);
    if ((tail[0] === '+' || tail[0] === '-') && tail[3] === ':') {
      return true;
    }
  }
  return false;
}

function joinPath(parentPath: string, fieldName: string): string {
  return parentPath === '' ? fieldName : `${parentPath}.${fieldName}`;
}

type IncludePredicate = (f: FieldSpec) => boolean;

export function validateDto(
  spec: EntitySpec,
  dtoType: string,
  payload: any
): { fields: string[]; ok: boolean } {
  let targetFields: FieldSpec[] = [];
  // Nested obj/list members are filtered recursively by the same include rule
  // as their parent (contracts/rules/rest-conventions.md).
  let include: IncludePredicate = () => true;

  if (dtoType === 'create') {
    include = (f) => !f.readonly;
    targetFields = (spec.fields || []).filter(include);
  } else if (dtoType === 'update') {
    include = (f) => !f.readonly;
    targetFields = (spec.fields || [])
      .filter(include)
      .map((f) => ({ ...f, optional: true }));
  } else if (dtoType === 'read') {
    include = (f) => !f.writeonly;
    targetFields = (spec.fields || []).filter(include);
  } else if (dtoType.startsWith('action:')) {
    const actionName = dtoType.slice('action:'.length);
    const found = (spec.actions || []).find((a) => a.name === actionName);
    if (!found) {
      return { fields: ['_action'], ok: false };
    }
    targetFields = found.input || [];
  } else {
    return { fields: ['_dto'], ok: false };
  }

  const errMap = new Set<string>();
  validateObject(targetFields, payload, '', include, errMap);

  if (errMap.size === 0) {
    return { fields: [], ok: true };
  }

  const sortedFields = Array.from(errMap).sort();
  return { fields: sortedFields, ok: false };
}

function validateObject(
  fields: FieldSpec[],
  payload: any,
  currentPath: string,
  include: IncludePredicate,
  errMap: Set<string>
): void {
  if (typeof payload !== 'object' || payload === null || Array.isArray(payload)) {
    if (currentPath !== '') {
      errMap.add(currentPath);
    } else {
      errMap.add('_root');
    }
    return;
  }

  const fieldByName = new Map<string, FieldSpec>();
  for (const f of fields) {
    fieldByName.set(f.name, f);
  }

  // 1. Strict object check for unrecognized keys
  for (const k of Object.keys(payload)) {
    if (!fieldByName.has(k)) {
      errMap.add(joinPath(currentPath, k));
    }
  }

  // 2. Validate declared fields
  for (const f of fields) {
    const fPath = joinPath(currentPath, f.name);
    const exists = Object.prototype.hasOwnProperty.call(payload, f.name);
    const val = payload[f.name];

    if (!exists) {
      if (!f.optional) {
        errMap.add(fPath);
      }
      continue;
    }

    if (val === null) {
      if (!f.nullable) {
        errMap.add(fPath);
      }
      continue;
    }

    validateFieldValue(f, val, fPath, include, errMap);
  }
}

function validateFieldValue(
  f: FieldSpec,
  val: any,
  path: string,
  include: IncludePredicate,
  errMap: Set<string>
): void {
  switch (f.type) {
    case 'str':
    case 'ref':
      validateString(f, val, path, errMap);
      break;
    case 'int':
      validateInt(f, val, path, errMap);
      break;
    case 'float':
      validateFloat(f, val, path, errMap);
      break;
    case 'bool':
      validateBool(val, path, errMap);
      break;
    case 'datetime':
      validateDateTime(val, path, errMap);
      break;
    case 'enum':
      validateEnum(f, val, path, errMap);
      break;
    case 'list':
      validateList(f, val, path, include, errMap);
      break;
    case 'obj':
      validateObjField(f, val, path, include, errMap);
      break;
    default:
      errMap.add(path);
  }
}

function validateString(
  f: FieldSpec,
  val: any,
  path: string,
  errMap: Set<string>
): void {
  if (typeof val !== 'string') {
    errMap.add(path);
    return;
  }
  // min/max count Unicode code points, not UTF-16 code units.
  const length = f.min !== undefined || f.max !== undefined ? Array.from(val).length : 0;
  if (f.min !== undefined && length < f.min) {
    errMap.add(path);
    return;
  }
  if (f.max !== undefined && length > f.max) {
    errMap.add(path);
    return;
  }
  if (f.format === 'email') {
    if (!EMAIL_PATTERN.test(val)) {
      errMap.add(path);
      return;
    }
  } else if (f.format === 'uuid') {
    if (!UUID_PATTERN.test(val)) {
      errMap.add(path);
      return;
    }
  } else if (f.format === 'uri') {
    if (!URI_PATTERN.test(val)) {
      errMap.add(path);
      return;
    }
  } else if (f.pattern) {
    try {
      const re = new RegExp(f.pattern);
      if (!re.test(val)) {
        errMap.add(path);
        return;
      }
    } catch {
      errMap.add(path);
      return;
    }
  }
}

function validateInt(
  f: FieldSpec,
  val: any,
  path: string,
  errMap: Set<string>
): void {
  if (typeof val !== 'number' || !Number.isInteger(val)) {
    errMap.add(path);
    return;
  }
  if (f.min !== undefined && val < f.min) {
    errMap.add(path);
  }
  if (f.max !== undefined && val > f.max) {
    errMap.add(path);
  }
}

function validateFloat(
  f: FieldSpec,
  val: any,
  path: string,
  errMap: Set<string>
): void {
  if (typeof val !== 'number' || isNaN(val) || !isFinite(val)) {
    errMap.add(path);
    return;
  }
  if (f.min !== undefined && val < f.min) {
    errMap.add(path);
  }
  if (f.max !== undefined && val > f.max) {
    errMap.add(path);
  }
}

function validateBool(val: any, path: string, errMap: Set<string>): void {
  if (typeof val !== 'boolean') {
    errMap.add(path);
  }
}

function validateDateTime(val: any, path: string, errMap: Set<string>): void {
  if (typeof val !== 'string') {
    errMap.add(path);
    return;
  }
  const d = new Date(val);
  if (isNaN(d.getTime())) {
    errMap.add(path);
    return;
  }
  if (!hasExplicitUtcOffset(val)) {
    errMap.add(path);
  }
}

function validateEnum(
  f: FieldSpec,
  val: any,
  path: string,
  errMap: Set<string>
): void {
  if (typeof val !== 'string') {
    errMap.add(path);
    return;
  }
  if (!f.enum || !f.enum.includes(val)) {
    errMap.add(path);
  }
}

function validateList(
  f: FieldSpec,
  val: any,
  path: string,
  include: IncludePredicate,
  errMap: Set<string>
): void {
  if (!Array.isArray(val)) {
    errMap.add(path);
    return;
  }
  if (f.item) {
    for (let i = 0; i < val.length; i++) {
      validateFieldValue(f.item, val[i], `${path}.${i}`, include, errMap);
    }
  }
}

function validateObjField(
  f: FieldSpec,
  val: any,
  path: string,
  include: IncludePredicate,
  errMap: Set<string>
): void {
  validateObject((f.fields || []).filter(include), val, path, include, errMap);
}

export function resolveEntitySpec(specOrClass: any): EntitySpec {
  if (!specOrClass) {
    throw new Error('specOrClass is required');
  }
  if (typeof specOrClass === 'function') {
    if (typeof (specOrClass as any).entitySpec === 'function') {
      return (specOrClass as any).entitySpec();
    }
    if ((specOrClass as any).entitySpec && typeof (specOrClass as any).entitySpec === 'object') {
      return (specOrClass as any).entitySpec;
    }
    if ((specOrClass as any).__entity_spec__) {
      return (specOrClass as any).__entity_spec__;
    }
    try {
      const { entitySpec } = require('@montionugera/entity-spec');
      return entitySpec(specOrClass);
    } catch {
      // ignore
    }
    try {
      const { entitySpec } = require('@montionugera/server-decorator-entity');
      return entitySpec(specOrClass);
    } catch {
      // ignore
    }
    throw new Error(`Unable to resolve EntitySpec from constructor ${specOrClass.name}`);
  }
  return specOrClass as EntitySpec;
}

export function enforceScopeAuth(
  requiredScopes: string[],
  extractor?: ScopeExtractor
) {
  return async (req: any, res: any, next: (err?: any) => void): Promise<void> => {
    // Fail closed: declared security with no extractor never exposes the route.
    if (!extractor) {
      writeProblem(
        res,
        401,
        'Unauthorized',
        'authentication required',
        req.originalUrl || req.url
      );
      return;
    }
    let authResult: { authenticated: boolean; scopes: string[] };
    try {
      authResult = await extractor(req);
    } catch {
      writeProblem(
        res,
        401,
        'Unauthorized',
        'authentication required',
        req.originalUrl || req.url
      );
      return;
    }

    if (!authResult?.authenticated) {
      writeProblem(
        res,
        401,
        'Unauthorized',
        'authentication required',
        req.originalUrl || req.url
      );
      return;
    }

    if (requiredScopes && requiredScopes.length > 0) {
      const { ok, missing } = checkScopes(requiredScopes, authResult.scopes || []);
      if (!ok) {
        writeProblem(
          res,
          403,
          'Forbidden',
          `missing required scope: ${missing}`,
          req.originalUrl || req.url
        );
        return;
      }
    }

    return next();
  };
}

export function mountExpressRoutes(
  router: any,
  specOrClass: any,
  handler: EntityHandler,
  options?: ExpressAdapterOptions
): any {
  const spec = resolveEntitySpec(specOrClass);
  const extractor = options?.authExtractor;

  let idField = 'id';
  for (const f of spec.fields || []) {
    if (f.role === 'id') {
      idField = f.name;
      break;
    }
  }

  const cleanPath = spec.path.replace(/^\/+|\/+$/g, '');
  const basePath = `/${cleanPath}`;
  const itemPath = `${basePath}/:${idField}`;

  const filterableFields = new Set<string>();
  for (const f of spec.fields || []) {
    if (f.filterable) {
      filterableFields.add(f.name);
    }
  }

  for (const op of spec.ops || []) {
    const middleware: any[] = [];
    if (spec.security?.ops && Object.prototype.hasOwnProperty.call(spec.security.ops, op)) {
      const required = spec.security.ops[op];
      // An entry of [] means authentication required, no particular scope.
      if (Array.isArray(required)) {
        middleware.push(enforceScopeAuth(required, extractor));
      }
    }

    switch (op) {
      case 'list': {
        router.get(basePath, ...middleware, async (req: any, res: any) => {
          try {
            let limit = 20;
            if (req.query?.limit !== undefined) {
              const parsed = parseInt(String(req.query.limit), 10);
              if (!isNaN(parsed) && parsed >= 0) {
                limit = parsed > 100 ? 100 : parsed;
              }
            }

            let offset = 0;
            if (req.query?.offset !== undefined) {
              const parsed = parseInt(String(req.query.offset), 10);
              if (!isNaN(parsed) && parsed >= 0) {
                offset = parsed;
              }
            }

            const filters: Record<string, string> = {};
            for (const name of filterableFields) {
              if (req.query && req.query[name] !== undefined) {
                filters[name] = String(req.query[name]);
              }
            }

            const result = await handler.list({ limit, offset, filters });
            res.status(200).json({
              items: result?.items || [],
              total: result?.total ?? 0,
              limit,
              offset,
            });
          } catch (err: any) {
            writeProblem(
              res,
              500,
              'Internal Server Error',
              err?.message || 'Internal server error',
              req.originalUrl || req.url
            );
          }
        });
        break;
      }

      case 'get': {
        router.get(itemPath, ...middleware, async (req: any, res: any) => {
          const id = req.params[idField];
          try {
            const result = await handler.get(id);
            if (result === null || result === undefined) {
              writeProblem(
                res,
                404,
                'Not Found',
                `entity with id ${id} not found`,
                req.originalUrl || req.url
              );
              return;
            }
            res.status(200).json(result);
          } catch (err: any) {
            if (err instanceof NotFoundError || err?.status === 404 || err?.statusCode === 404) {
              writeProblem(
                res,
                404,
                'Not Found',
                err.message || `entity with id ${id} not found`,
                req.originalUrl || req.url
              );
              return;
            }
            writeProblem(
              res,
              500,
              'Internal Server Error',
              err?.message || 'Internal server error',
              req.originalUrl || req.url
            );
          }
        });
        break;
      }

      case 'create': {
        router.post(basePath, ...middleware, async (req: any, res: any) => {
          const body = req.body;
          if (typeof body !== 'object' || body === null || Array.isArray(body)) {
            writeValidationProblem(res, ['_body'], req.originalUrl || req.url);
            return;
          }

          const { fields, ok } = validateDto(spec, 'create', body);
          if (!ok) {
            writeValidationProblem(res, fields, req.originalUrl || req.url);
            return;
          }

          try {
            const result = await handler.create(body);
            res.status(201).json(result);
          } catch (err: any) {
            writeProblem(
              res,
              500,
              'Internal Server Error',
              err?.message || 'Internal server error',
              req.originalUrl || req.url
            );
          }
        });
        break;
      }

      case 'update': {
        router.patch(itemPath, ...middleware, async (req: any, res: any) => {
          const id = req.params[idField];
          const body = req.body;
          if (typeof body !== 'object' || body === null || Array.isArray(body)) {
            writeValidationProblem(res, ['_body'], req.originalUrl || req.url);
            return;
          }

          const { fields, ok } = validateDto(spec, 'update', body);
          if (!ok) {
            writeValidationProblem(res, fields, req.originalUrl || req.url);
            return;
          }

          try {
            const result = await handler.update(id, body);
            if (result === null || result === undefined) {
              writeProblem(
                res,
                404,
                'Not Found',
                `entity with id ${id} not found`,
                req.originalUrl || req.url
              );
              return;
            }
            res.status(200).json(result);
          } catch (err: any) {
            if (err instanceof NotFoundError || err?.status === 404 || err?.statusCode === 404) {
              writeProblem(
                res,
                404,
                'Not Found',
                err.message || `entity with id ${id} not found`,
                req.originalUrl || req.url
              );
              return;
            }
            writeProblem(
              res,
              500,
              'Internal Server Error',
              err?.message || 'Internal server error',
              req.originalUrl || req.url
            );
          }
        });
        break;
      }

      case 'delete': {
        router.delete(itemPath, ...middleware, async (req: any, res: any) => {
          const id = req.params[idField];
          try {
            await handler.delete(id);
            res.status(204).send();
          } catch (err: any) {
            if (err instanceof NotFoundError || err?.status === 404 || err?.statusCode === 404) {
              writeProblem(
                res,
                404,
                'Not Found',
                err.message || `entity with id ${id} not found`,
                req.originalUrl || req.url
              );
              return;
            }
            writeProblem(
              res,
              500,
              'Internal Server Error',
              err?.message || 'Internal server error',
              req.originalUrl || req.url
            );
          }
        });
        break;
      }
    }
  }

  for (const action of spec.actions || []) {
    const actionRoute = `${itemPath}/actions/${action.name}`;
    const middleware: any[] = [];
    if (
      spec.security?.actions &&
      Object.prototype.hasOwnProperty.call(spec.security.actions, action.name)
    ) {
      const required = spec.security.actions[action.name];
      // An entry of [] means authentication required, no particular scope.
      if (Array.isArray(required)) {
        middleware.push(enforceScopeAuth(required, extractor));
      }
    }

    router.post(actionRoute, ...middleware, async (req: any, res: any) => {
      const id = req.params[idField];
      const body = req.body || {};

      if (action.input && action.input.length > 0) {
        if (typeof body !== 'object' || body === null || Array.isArray(body)) {
          writeValidationProblem(res, ['_body'], req.originalUrl || req.url);
          return;
        }

        const { fields, ok } = validateDto(spec, `action:${action.name}`, body);
        if (!ok) {
          writeValidationProblem(res, fields, req.originalUrl || req.url);
          return;
        }
      }

      try {
        if (!handler.action) {
          throw new Error(`Handler does not support actions`);
        }
        const result = await handler.action(id, action.name, body);
        res.status(200).json(result);
      } catch (err: any) {
        if (err instanceof NotFoundError || err?.status === 404 || err?.statusCode === 404) {
          writeProblem(
            res,
            404,
            'Not Found',
            err.message || `entity with id ${id} not found`,
            req.originalUrl || req.url
          );
          return;
        }
        writeProblem(
          res,
          500,
          'Internal Server Error',
          err?.message || 'Internal server error',
          req.originalUrl || req.url
        );
      }
    });
  }

  return router;
}
