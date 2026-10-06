import { validateSecurity } from './validate';
import { SecurityScheme, SecuritySpec } from './types';

const bearer: SecurityScheme = { name: 'bearer', type: 'http', scheme: 'bearer' };
const check = (security: SecuritySpec | undefined, ops = ['list'], actions = ['publish']) =>
  validateSecurity(security, ops, actions, 'Widget');

describe('validateSecurity', () => {
  it('accepts an absent block and a fully consistent one', () => {
    expect(() => check(undefined)).not.toThrow();
    expect(() =>
      check({
        schemes: [bearer, { name: 'key', type: 'apiKey', in: 'header', paramName: 'X-Api-Key' }],
        ops: { list: ['widget:read'] },
        actions: { publish: ['widget:write'] },
      }),
    ).not.toThrow();
  });

  it('rejects an empty scheme list', () => {
    expect(() => check({ schemes: [] })).toThrow('Widget: security.schemes must not be empty');
  });

  it('rejects an http scheme without "scheme"', () => {
    expect(() => check({ schemes: [{ name: 'h', type: 'http' }] })).toThrow(
      'Widget: scheme "h": http requires "scheme"',
    );
  });

  it.each([
    ['in', { name: 'k', type: 'apiKey', paramName: 'X-Api-Key' }],
    ['paramName', { name: 'k', type: 'apiKey', in: 'header' }],
  ] as Array<[string, SecurityScheme]>)('rejects an apiKey scheme without "%s"', (_missing, scheme) => {
    expect(() => check({ schemes: [scheme] })).toThrow(
      'Widget: scheme "k": apiKey requires "in" and "paramName"',
    );
  });

  it('rejects requirements for an action the entity does not declare', () => {
    expect(() => check({ schemes: [bearer], actions: { archive: ['widget:write'] } })).toThrow(
      'Widget: security.actions.archive is not a declared action',
    );
  });
});
