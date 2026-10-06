/** @type {import('ts-jest').JestConfigWithTsJest} **/
module.exports = {
  preset: 'ts-jest',
  testEnvironment: 'node',
  roots: ['<rootDir>/src'],
  testMatch: ['**/*.spec.ts'],
  testTimeout: 10000,
  // Coverage gate (unit lane only). `test:unit` passes --coverage. The thresholds are a ratchet
  // kept a little below the measured values (lines 100, branches 91.66) so an
  // instrumentation wobble cannot fail CI. Raise them as tests land, never lower them.
  // text-only reporters: nothing is written to disk, so no coverage/ directory to gitignore.
  collectCoverageFrom: ['src/**/*.ts', '!src/**/*.spec.ts', '!src/**/*.d.ts'],
  coverageReporters: ['text', 'text-summary'],
  coverageThreshold: { global: { lines: 98, branches: 88 } },
};
