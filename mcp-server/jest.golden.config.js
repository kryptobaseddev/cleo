/**
 * Jest configuration for CLEO MCP Server Golden & Safety Tests
 *
 * Covers test suites in the tests/ directory:
 * - tests/golden/ - Golden parity fixture tests
 * - tests/degradation/ - CLI-required degradation path tests
 * - tests/safety/ - Mixed-writer and atomic write safety tests
 *
 * @task T4338
 */

export default {
  preset: 'ts-jest/presets/default-esm',
  testEnvironment: 'node',
  extensionsToTreatAsEsm: ['.ts'],
  moduleNameMapper: {
    '^(\\.{1,2}/.*)\\.js$': '$1',
  },
  transform: {
    '^.+\\.ts$': [
      'ts-jest',
      {
        useESM: true,
      },
    ],
  },
  testMatch: [
    '<rootDir>/tests/golden/**/*.test.ts',
    '<rootDir>/tests/degradation/**/*.test.ts',
    '<rootDir>/tests/safety/**/*.test.ts',
  ],
  collectCoverageFrom: [],
  verbose: true,
  testTimeout: 30000,
  maxWorkers: 1, // Safety tests involve file locking; run serially
};
