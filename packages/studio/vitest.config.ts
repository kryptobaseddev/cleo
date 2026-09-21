/**
 * Vitest configuration for @cleocode/studio.
 *
 * Runs server-side utility tests (adapters, types) plus `.svelte.ts` runes
 * modules (T951 — shared URL-state stores) in node environment. Svelte
 * `.svelte` component tests are still out of scope; component DOM
 * assertions live in the browser e2e suite.
 *
 * The Svelte vite plugin is enabled with `extensions: ['.svelte']` so only
 * component files trigger component compilation; `.svelte.ts` modules are
 * handled by the plugin's built-in module-runes preprocessing.
 */

import { svelte, vitePreprocess } from '@sveltejs/vite-plugin-svelte';
import { defineConfig } from 'vitest/config';
import { withWorkspaceSubpathAliases } from '../../vitest-workspace-resolver.js';
import { MEMORY_SAFE_TEST_DEFAULTS } from '../../vitest.memory-safe.js';

export default defineConfig({
  plugins: [
    svelte({
      preprocess: vitePreprocess(),
      compilerOptions: { runes: true },
    }),
  ],
  test: {
    // Memory-safe fork bounds (T12087) — spread FIRST so anything below
    // can still override deliberately. Applies on a DIRECT per-package run,
    // which `extends: true` does not cover.
    ...MEMORY_SAFE_TEST_DEFAULTS,
    extends: true,
    name: '@cleocode/studio',
    globals: true,
    environment: 'node',
    testTimeout: 30_000,
    hookTimeout: 30_000,
    include: [
      'src/**/*.test.ts',
      'src/**/__tests__/*.test.ts',
    ],
    exclude: ['node_modules', 'dist', '**/node_modules/**', '**/e2e/**', '**/*.integration.test.ts', '**/*-integration.test.ts'],
    // File-based Vitest projects do not inherit root aliases. Resolve SDK
    // imports to source so stale dist files cannot hide task-policy regressions.
    alias: withWorkspaceSubpathAliases({
      $lib: new URL('./src/lib', import.meta.url).pathname,
      '@cleocode/core': new URL('../core/src/index.ts', import.meta.url).pathname,
      '@cleocode/contracts': new URL('../contracts/src/index.ts', import.meta.url).pathname,
    }),
    server: {
      deps: {
        // Svelte runes-in-TS modules must be inlined so the plugin processes them.
        inline: [/\.svelte\.ts$/],
      },
    },
  },
});
