/**
 * Jest configuration for CLEO MCP Server Integration Tests
 *
 * Integration tests validate full request/response flow through:
 * Gateway → Domain Router → Domain Handler → CLI Executor → Response Formatter
 *
 * Requirements:
 * - CLEO CLI must be installed and accessible
 * - Tests run against real CLI commands
 * - Longer timeout (120s) for full stack operations
 * - No coverage threshold (integration tests measure behavior, not coverage)
 *
 * @task T2922
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
  testMatch: ['**/__tests__/**/*.integration.test.ts'],
  collectCoverageFrom: [],
  verbose: true,
  roots: ['<rootDir>/src'],
  testTimeout: 120000, // 120s for full stack operations
  setupFilesAfterEnv: ['<rootDir>/src/__tests__/setup.ts'],
  maxWorkers: 1, // Run integration tests serially to avoid conflicts
};
