/** @type {import('ts-jest').JestConfigWithTsJest} **/
module.exports = {
  preset: 'ts-jest',
  testEnvironment: 'node',
  roots: ['<rootDir>/src'],
  testMatch: ['**/*.spec.ts'],
  testTimeout: 10000,
  // Coverage gate (unit lane only). `test:unit` passes --coverage. Lines are a ratchet at the
  // achieved 100; branches are gated a little below the measured 86.84. Raise them as tests land,
  // never lower them.
  // text-only reporters: nothing is written to disk, so no coverage/ directory to gitignore.
  collectCoverageFrom: ['src/**/*.ts', '!src/**/*.spec.ts', '!src/**/*.d.ts'],
  coverageReporters: ['text', 'text-summary'],
  coverageThreshold: { global: { lines: 100, branches: 84 } },
};
