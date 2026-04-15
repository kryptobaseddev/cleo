/**
 * Vitest configuration for @cleocode/studio.
 *
 * Runs server-side utility tests (adapters, types) in node environment.
 * Svelte component tests are out of scope — this config covers the
 * `src/lib/server/` layer only.
 */

import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    testTimeout: 30_000,
    hookTimeout: 30_000,
    include: [
      'src/**/*.test.ts',
      'src/**/__tests__/*.test.ts',
    ],
    exclude: ['node_modules', 'dist', '**/node_modules/**', '**/e2e/**'],
    // SvelteKit $lib alias resolution for server-side tests
    alias: {
      '$lib': new URL('./src/lib', import.meta.url).pathname,
    },
  },
});
