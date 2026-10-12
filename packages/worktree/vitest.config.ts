import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';
import { withWorkspaceSubpathAliases } from '../../vitest-workspace-resolver.js';
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
    alias: withWorkspaceSubpathAliases({ '@cleocode/paths': fileURLToPath(new URL('../paths/src/index.ts', import.meta.url)) }),
    name: '@cleocode/worktree',
    globals: true,
    environment: 'node',
    include: [
      'src/**/*.test.ts',
      'src/**/__tests__/*.test.ts',
      'tests/**/*.test.ts',
    ],
  },
});
