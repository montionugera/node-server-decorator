/** @type {import('ts-jest').JestConfigWithTsJest} **/
module.exports = {
  preset: 'ts-jest',
  testEnvironment: 'node',
  roots: ['<rootDir>/src'],
  testMatch: ['**/?(*.)+(spec|test).ts'],
  transform: {
    '^.+\\.ts$': 'ts-jest',
  },
  // Configure different test patterns.
  // NOTE: `testTimeout` is NOT a valid per-project key in jest-config@29 (it's global-only) —
  // Jest logs "Unknown option testTimeout" at startup and silently ignores it, falling back to
  // its 5000ms default for any hook/test without its own inline override. Real per-suite
  // timeouts for the e2e (testcontainers) suites are set via `jest.setTimeout(...)` at the top
  // of each spec file instead — see cache-redis.e2e.spec.ts,
  // emit-on-success-kafka-testcontainers.e2e.spec.ts, queue-registry-redis-integration.e2e.spec.ts,
  // emit-on-success-redis-testcontainers.e2e.spec.ts, emit-rabbitmq-simple.e2e.spec.ts, and
  // rabbitmq-amqp-testcontainers.e2e.spec.ts. (multi-decorator-workflow.e2e.spec.ts uses no
  // containers and keeps Jest's default.)
  projects: [
    {
      displayName: 'unit',
      testMatch: ['<rootDir>/src/**/*.spec.ts'],
      testPathIgnorePatterns: ['/node_modules/', '/dist/', '/integration/'],
      preset: 'ts-jest',
      testEnvironment: 'node'
    },
    {
      displayName: 'e2e',
      testMatch: ['<rootDir>/src/integration/**/*.spec.ts'],
      preset: 'ts-jest',
      testEnvironment: 'node'
    }
  ]
};