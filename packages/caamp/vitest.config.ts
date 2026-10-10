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
    alias: withWorkspaceSubpathAliases({ '@cleocode/paths': fileURLToPath(new URL('../paths/src/index.ts', import.meta.url)) }),
    name: '@cleocode/caamp',
    globals: true,
    environment: 'node',
    include: ['tests/**/*.test.ts'],
    coverage: {
      provider: 'v8',
      include: ['src/**/*.ts'],
      exclude: [
        'src/cli.ts',
        'src/index.ts',
        'src/types.ts',
        'src/commands/providers.ts',
        'src/core/registry/types.ts',
        'src/core/registry/spawn-adapter.ts',
        'src/core/marketplace/types.ts',
        'src/core/skills/skill-library.ts',
      ],
      reporter: ['text', 'json-summary', 'lcov'],
      thresholds: {
        lines: 98,
        functions: 98,
        statements: 97,
        branches: 91,
      },
    },
  },
});
