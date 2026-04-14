/**
 * Vitest configuration for @cleocode/skills.
 *
 * Test files live under skills/ (not src/) because this package ships
 * bundled skill definitions rather than compiled TypeScript source.
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
      'skills/**/__tests__/*.test.ts',
      'skills/**/*.test.ts',
    ],
    exclude: ['node_modules', 'dist', '**/node_modules/**'],
  },
});
