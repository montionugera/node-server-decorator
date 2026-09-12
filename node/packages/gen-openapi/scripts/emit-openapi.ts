import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { canonicalJson, entitySpec } from '@montionugera/entity-spec';
import { UserFixture } from '@montionugera/entity-spec/testing';
import { openapiDocument } from '../src/document';

const version = readFileSync(join(__dirname, '../../../../contracts/VERSION'), 'utf8').trim();
process.stdout.write(canonicalJson(openapiDocument([entitySpec(UserFixture)], version)));
