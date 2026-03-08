import { defineConfig } from 'vitest/config';

process.env.NODE_NO_WARNINGS ??= '1';

// Tests excluded in CI due to spawn-heavy CLI execution (~5-9 min on Windows).
// Run locally with: npx vitest run --config vitest.config.ts (no SKIP_SLOW_TESTS)
// Or explicitly: npx vitest run src/mcp/gateways/__tests__/mutate.integration.test.ts
const SLOW_TESTS = [
  'src/mcp/gateways/__tests__/mutate.integration.test.ts',
  'src/mcp/__tests__/e2e/error-handling.test.ts',
];

const excluded = process.env.CI === 'true'
  ? [...SLOW_TESTS]
  : [];

/**
 * Vitest configuration for CLEO V2
 * @epic T4454
 */
export default defineConfig({
  test: {
    globals: true,
    include: ['src/**/*.test.ts', 'tests/**/*.test.ts'],
    exclude: ['node_modules', 'dist', ...excluded],
    testTimeout: 30_000,
    hookTimeout: 30_000,
    pool: 'forks',
    maxWorkers: 4
  },
  resolve: {
    alias: {
      'node:sqlite': 'node:sqlite'
    }
  }
});
