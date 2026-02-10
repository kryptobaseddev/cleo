/**
 * Jest configuration for CLEO MCP Server E2E Tests
 *
 * E2E tests validate complete workflow scenarios through:
 * Gateway → Domain Router → Domain Handler → CLI Executor → Response Formatter
 *
 * Requirements:
 * - CLEO CLI must be installed and accessible
 * - Tests run against real CLI commands in a real .cleo project
 * - Longer timeout (120s) for full workflow operations
 * - No coverage threshold (E2E tests measure behavior, not coverage)
 *
 * @task T2937
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
  testMatch: ['**/__tests__/e2e/**/*.test.ts'],
  collectCoverageFrom: [],
  verbose: true,
  roots: ['<rootDir>/src'],
  testTimeout: 120000, // 120s for full workflow operations
  setupFilesAfterEnv: ['<rootDir>/src/__tests__/setup.ts'],
  maxWorkers: 1, // Run E2E tests serially to avoid conflicts
};
