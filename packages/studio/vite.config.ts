import { sveltekit } from '@sveltejs/kit/vite';
import { defineConfig } from 'vite';

/**
 * T1693: WASM stub plugin.
 *
 * Rollup (used by Vite 8 SSR build) cannot process binary .wasm files —
 * it throws "Unexpected character '\0'". This plugin intercepts .wasm imports
 * and returns a stub module that defers loading to the runtime `WebAssembly` API.
 *
 * This is needed for loro-crdt (transitively imported from llmtxt which is
 * used by @cleocode/core). The stub is sufficient for the SSR build phase;
 * the wasm binary is not executed during SvelteKit's pre-render / adapter
 * stage.
 */
const wasmStubPlugin = {
  name: 'cleo-wasm-stub',
  load(id: string) {
    if (id.endsWith('.wasm') || id.endsWith('.wasm?url') || id.endsWith('.wasm?init')) {
      // Return a stub that satisfies the import but defers wasm initialisation
      // to the consumer (llmtxt handles lazy wasm loading internally).
      return `
export default {};
export function initSync() { return {}; }
export async function default_init() { return {}; }
`;
    }
    return null;
  },
};

/**
 * T1693: node-cron CJS globals patch.
 *
 * node-cron@4.x ships an ESM build but uses `__dirname` / `__filename`
 * via its CJS compatibility shim. These globals are undefined in pure ESM
 * (Node.js 24 / Vite SSR). Replace them with the ESM-safe equivalents at
 * bundle time so SvelteKit's node adapter can execute the server output.
 */
const patchCjsGlobalsPlugin = {
  name: 'cleo-patch-cjs-globals',
  transform(code: string, id: string) {
    if (id.includes('node-cron') && (code.includes('__dirname') || code.includes('__filename'))) {
      return {
        code: code
          .replace(/\b__dirname\b/g, 'new URL(".", import.meta.url).pathname.replace(/\\/+$/, "")')
          .replace(/\b__filename\b/g, 'new URL(import.meta.url).pathname'),
        map: null,
      };
    }
    return null;
  },
};

export default defineConfig({
  plugins: [
    // Must be before sveltekit() so wasm stubs are resolved first
    wasmStubPlugin,
    patchCjsGlobalsPlugin,
    sveltekit(),
  ],
  server: {
    port: 3456,
    strictPort: true,
  },
  // T1693: loro-crdt and llmtxt depend on WASM — mark as external in SSR so
  // Rollup never tries to bundle the binary. The wasmStubPlugin above handles
  // any .wasm imports that slip through during the SSR phase.
  ssr: {
    // T1693: noExternal ensures Vite bundles @cleocode/* packages by default.
    // The explicit excludes below override that for WASM-dependent packages.
    noExternal: [/^@cleocode\//],
    external: ['loro-crdt', 'llmtxt'],
  },
});
