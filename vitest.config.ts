import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    testTimeout: 60000,
    hookTimeout: 60000,
    // Note: VITEST env var is auto-set by vitest. Enforcement code checks
    // process.env.VITEST to disable enforcement during test runs.
    // Tests that validate enforcement directly must clear VITEST in beforeAll.
    include: [
      'packages/*/src/**/*.test.ts',
      'packages/*/src/**/__tests__/*.test.ts',
    ],
    exclude: [
      'node_modules',
      'dist',
      '**/node_modules/**',
      // E2E and integration tests require CLI/DB setup — run separately
      '**/e2e/**',
      '**/*.integration.test.ts',
      '**/*-integration.test.ts',
    ],
    // Path aliases matching tsconfig — resolve workspace packages to source
    // TypeScript so Vitest can import them without a build step.
    alias: {
      '@cleocode/contracts': new URL('./packages/contracts/src/index.ts', import.meta.url).pathname,
      '@cleocode/core/internal': new URL('./packages/core/src/internal.ts', import.meta.url).pathname,
      '@cleocode/core': new URL('./packages/core/src/index.ts', import.meta.url).pathname,
      '@cleocode/adapters': new URL('./packages/adapters/src/index.ts', import.meta.url).pathname,
    },
  },
});
