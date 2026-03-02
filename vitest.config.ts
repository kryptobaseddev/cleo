import { defineConfig } from 'vitest/config';

process.env.NODE_NO_WARNINGS ??= '1';

/**
 * Vitest configuration for CLEO V2
 * @epic T4454
 */
export default defineConfig({
  test: {
    globals: true,
    include: ['src/**/*.test.ts', 'tests/**/*.test.ts'],
    exclude: ['node_modules', 'dist'],
    testTimeout: 30_000,
    hookTimeout: 30_000,
    pool: 'forks'
  },
  resolve: {
    alias: {
      'node:sqlite': 'node:sqlite'
    }
  }
});
