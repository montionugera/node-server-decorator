import { Restful, action, id, email, str, enumOf, int, listOf, obj, datetime } from '../index';

@Restful({ path: 'users', transports: ['rest', 'rpc', 'sse', 'ws'] })
class User {
  @id() id!: string;
  @email({ filterable: true }) email!: string;
  @str({ min: 2, max: 80 }) name!: string;
  @enumOf(['inactive', 'active', 'banned'], { filterable: true }) status!: string;
  @int({ min: 0, readonly: true }) loginCount!: number;
  @listOf({ type: 'str' }) tags!: string[];
  @obj([{ name: 'bio', type: 'str', max: 500, optional: true }], { optional: true })
  profile?: { bio?: string };
  @datetime({ optional: true, nullable: true }) birthday?: string | null;

  @action('activate', { from: 'inactive', to: 'active',
    input: [{ name: 'reason', type: 'str', max: 200, optional: true }] })
  activate(): void {}

  @action('ping')
  ping(): void {}
}

export { User as UserFixture };
