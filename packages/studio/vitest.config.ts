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

import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { svelte, vitePreprocess } from '@sveltejs/vite-plugin-svelte';
import { defineConfig } from 'vitest/config';

const studioRoot = new URL('.', import.meta.url);

// SvelteKit's generated tsconfig is gitignored, but Vite's TS transform needs
// the file referenced by tsconfig.json even for route handler unit tests.
if (!existsSync(new URL('./.svelte-kit/tsconfig.json', studioRoot))) {
  execFileSync('pnpm', ['exec', 'svelte-kit', 'sync'], {
    cwd: studioRoot,
    stdio: 'ignore',
  });
}

export default defineConfig({
  root: studioRoot.pathname,
  plugins: [
    svelte({
      preprocess: vitePreprocess(),
      compilerOptions: { runes: true },
    }),
  ],
  test: {
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
    // SvelteKit $lib alias resolution for server-side tests
    alias: {
      $lib: new URL('./src/lib', import.meta.url).pathname,
    },
    server: {
      deps: {
        // Svelte runes-in-TS modules must be inlined so the plugin processes them.
        inline: [/\.svelte\.ts$/],
      },
    },
  },
});
