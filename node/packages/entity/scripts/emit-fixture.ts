import { entitySpecCanonical } from '../src/index';
import { UserFixture } from '../src/testing/user-fixture';
process.stdout.write(entitySpecCanonical(UserFixture));
