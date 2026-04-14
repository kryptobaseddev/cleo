/**
 * Vitest configuration for @cleocode/contracts.
 *
 * Provides path aliases so tests can import from source without a prior
 * build step.
 *
 * @task T566
 */

import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    testTimeout: 60_000,
    hookTimeout: 60_000,
    include: [
      'src/**/*.test.ts',
      'src/**/__tests__/*.test.ts',
      'tests/**/*.test.ts',
    ],
    exclude: ['node_modules', 'dist', '**/node_modules/**', '**/e2e/**'],
    alias: {
      '@cleocode/contracts': new URL('./src/index.ts', import.meta.url).pathname,
    },
  },
});
