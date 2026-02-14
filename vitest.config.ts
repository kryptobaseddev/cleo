import { defineConfig } from 'vitest/config';

/**
 * Vitest configuration for CLEO V2
 * @epic T4454
 */
export default defineConfig({
  test: {
    globals: true,
    include: ['src/**/*.test.ts', 'src/**/__tests__/**/*.ts'],
    exclude: ['node_modules', 'dist'],
    testTimeout: 10_000,
    hookTimeout: 10_000,
  },
});
