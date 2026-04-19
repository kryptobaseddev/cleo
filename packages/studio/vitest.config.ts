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

export default defineConfig({
  plugins: [
    svelte({
      preprocess: vitePreprocess(),
      compilerOptions: { runes: true },
    }),
  ],
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
