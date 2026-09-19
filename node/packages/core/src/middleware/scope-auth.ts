export interface ProblemDetails {
  type: string;
  title: string;
  status: number;
  detail?: string;
  instance?: string;
}

export type ScopeExtractor = (
  req: any
) =>
  | Promise<{ authenticated: boolean; scopes: string[] }>
  | { authenticated: boolean; scopes: string[] };

export function checkScopes(
  required: string[],
  held: string[]
): { ok: boolean; missing?: string } {
  const heldSet = new Set(held || []);
  for (const req of required) {
    if (!heldSet.has(req)) {
      return { ok: false, missing: req };
    }
  }
  return { ok: true };
}

export interface ScopeAuthOptions {
  spec?: any;
  operation?: string;
  action?: string;
  requiredScopes?: string[];
  extractor: ScopeExtractor;
}

export function scopeAuthMiddleware(options: ScopeAuthOptions) {
  return async (req: any, res: any, next: (err?: any) => void): Promise<void> => {
    let required: string[] | undefined;

    if (options.requiredScopes !== undefined) {
      required = options.requiredScopes;
    } else if (options.spec?.security) {
      if (options.operation) {
        if (
          options.spec.security.ops &&
          Object.prototype.hasOwnProperty.call(options.spec.security.ops, options.operation)
        ) {
          required = options.spec.security.ops[options.operation];
        } else {
          return next();
        }
      } else if (options.action) {
        if (
          options.spec.security.actions &&
          Object.prototype.hasOwnProperty.call(options.spec.security.actions, options.action)
        ) {
          required = options.spec.security.actions[options.action];
        } else {
          return next();
        }
      } else {
        return next();
      }
    } else {
      return next();
    }

    const authResult = await options.extractor(req);

    if (!authResult?.authenticated) {
      if (res.setHeader) {
        res.setHeader('Content-Type', 'application/problem+json');
      }
      res.statusCode = 401;
      const problem: ProblemDetails = {
        type: 'about:blank',
        title: 'Unauthorized',
        status: 401,
        detail: 'authentication required',
        instance: req.originalUrl || req.url,
      };
      if (typeof res.end === 'function') {
        res.end(JSON.stringify(problem));
      }
      return;
    }

    if (required && required.length > 0) {
      const { ok, missing } = checkScopes(required, authResult.scopes || []);
      if (!ok) {
        if (res.setHeader) {
          res.setHeader('Content-Type', 'application/problem+json');
        }
        res.statusCode = 403;
        const problem: ProblemDetails = {
          type: 'about:blank',
          title: 'Forbidden',
          status: 403,
          detail: 'missing required scope: ' + missing,
          instance: req.originalUrl || req.url,
        };
        if (typeof res.end === 'function') {
          res.end(JSON.stringify(problem));
        }
        return;
      }
    }

    return next();
  };
}
