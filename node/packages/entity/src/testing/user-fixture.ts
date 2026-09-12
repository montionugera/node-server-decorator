import { Restful, action, id, email, str, enumOf, int, listOf, obj, datetime, float, bool } from '../index';

@Restful({
  path: 'users',
  transports: ['rest', 'rpc', 'sse', 'ws'],
  description: 'A registered user account',
  tags: ['identity'],
  security: {
    schemes: [{ name: 'bearerAuth', type: 'http', scheme: 'bearer', bearerFormat: 'JWT' }],
    ops: { create: ['user:write'], update: ['user:write'], delete: ['user:admin'] },
    actions: { activate: ['user:admin'] },
  },
})
class User {
  @id() id!: string;
  @email({ filterable: true, description: 'Primary contact address' }) email!: string;
  @str({ min: 2, max: 80 }) name!: string;
  @enumOf(['inactive', 'active', 'banned'], { filterable: true }) status!: string;
  @int({ min: 0, readonly: true }) loginCount!: number;
  @listOf({ type: 'str' }) tags!: string[];
  @obj([{ name: 'bio', type: 'str', max: 500, optional: true }], { optional: true })
  profile?: { bio?: string };
  @datetime({ optional: true, nullable: true }) birthday?: string | null;
  // I-d (P1 gate-review): writable, non-readonly fields to exercise DTO derivation rules the
  // original 16-case contract never touched (JSON-type strictness on float/bool, writeonly
  // exclusion from read).
  @float({ min: 0, optional: true }) score?: number;
  @bool({ optional: true }) active?: boolean;
  @str({ writeonly: true, max: 100, optional: true }) secretNote?: string;

  @action('activate', { from: 'inactive', to: 'active',
    description: 'Move a dormant account back to active',
    input: [{ name: 'reason', type: 'str', max: 200, optional: true }] })
  activate(): void {}

  @action('ping')
  ping(): void {}
}

export { User as UserFixture };
