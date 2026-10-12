import { defineConfig } from 'vitest/config';
import { MEMORY_SAFE_TEST_DEFAULTS } from '../../vitest.memory-safe.js';

export default defineConfig({
  test: {
    // Memory-safe fork bounds (T12087) — spread FIRST so anything below
    // can still override deliberately. Applies on a DIRECT per-package run,
    // which `extends: true` does not cover.
    ...MEMORY_SAFE_TEST_DEFAULTS,
    extends: true,
    // T13628: `extends: true` does not carry the root's timeouts across this
    // project's own root, so tests ran at vitest's 5 s default (see T13625).
    testTimeout: 120_000,
    hookTimeout: 120_000,
    name: '@cleocode/animations',
    globals: true,
    environment: 'node',
    include: [
      'src/**/*.test.ts',
      'src/**/__tests__/*.test.ts',
      'tests/**/*.test.ts',
    ],
    exclude: ['node_modules', 'dist', '**/node_modules/**', '**/e2e/**', '**/*.integration.test.ts', '**/*-integration.test.ts'],
  },
});
