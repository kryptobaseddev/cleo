/**
 * ESM-native migration folder resolver for @cleocode/core.
 *
 * Replaces fragile `__dirname` path-math with Node module resolution so the
 * correct migrations directory is found regardless of the calling layout:
 *
 *  - **Bundled** (esbuild dist/): @cleocode/core is a real npm package in
 *    node_modules — `createRequire().resolve('@cleocode/core')` returns
 *    `…/node_modules/@cleocode/core/dist/index.js`; two dirname() calls
 *    yield the package root.
 *  - **Workspace dev** (tsx source mode): pnpm links @cleocode/core to
 *    `packages/core/dist/index.js`; same dirname chain, same result.
 *  - **Global npm install**: `npm i -g @cleocode/cleo @cleocode/core` installs
 *    both packages; createRequire from the cleo binary resolves core via
 *    NODE_PATH or global node_modules — same dirname chain applies.
 *
 * Resolution order (synchronous):
 *  1. `import.meta.resolve('@cleocode/core', import.meta.url)` — ESM-native,
 *     Node 18.19+ (two-arg form with parent URL for self-resolution context).
 *  2. `createRequire(import.meta.url).resolve('@cleocode/core')` — CJS interop
 *     fallback, works everywhere including bundled esbuild output.
 *
 * @throws {Error} if both resolution strategies fail (indicates a broken
 *   install where @cleocode/core is not reachable from the current module).
 *
 * @task T1177
 * @epic T1150
 */

import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Derive the @cleocode/core package root from the resolved main entry path.
 *
 * The main entry exported by @cleocode/core is always `dist/index.js` (one
 * directory deep inside the package root), so two `dirname()` calls walk up:
 *   `…/core/dist/index.js` → `…/core/dist` → `…/core` (package root).
 */
function coreRootFromEntry(entryPath: string): string {
  return dirname(dirname(entryPath));
}

/**
 * Resolve the absolute path to a named drizzle migrations folder inside
 * `@cleocode/core`, robust to bundled / workspace / global-install layouts.
 *
 * @param setName - The migrations sub-directory name, e.g. `'drizzle-tasks'`.
 * @returns Absolute path to the migrations folder (may or may not exist on
 *   disk — callers that need the folder to exist should validate separately).
 * @throws {Error} If @cleocode/core cannot be resolved from the current module.
 *
 * @example
 * ```ts
 * const folder = resolveCorePackageMigrationsFolder('drizzle-tasks');
 * // → '/…/packages/core/migrations/drizzle-tasks'   (workspace dev)
 * // → '/…/node_modules/@cleocode/core/migrations/drizzle-tasks'  (installed)
 * ```
 */
export function resolveCorePackageMigrationsFolder(setName: string): string {
  // Strategy 1: ESM-native import.meta.resolve() with parent URL.
  // The two-argument form was stabilised in Node 18.19.0 / 20.x and is the
  // most correct way to resolve a specifier relative to an explicit parent.
  try {
    const resolved = import.meta.resolve('@cleocode/core', import.meta.url);
    const entryPath = fileURLToPath(resolved);
    return join(coreRootFromEntry(entryPath), 'migrations', setName);
  } catch {
    // Intentionally swallowed — fall through to Strategy 2.
  }

  // Strategy 2: createRequire().resolve() — synchronous, universally supported
  // CJS resolution algorithm that honours NODE_PATH, pnpm virtual store, and
  // workspace symlinks.
  const _require = createRequire(import.meta.url);
  try {
    const entryPath = _require.resolve('@cleocode/core');
    return join(coreRootFromEntry(entryPath), 'migrations', setName);
  } catch (err) {
    throw new Error(
      `resolveCorePackageMigrationsFolder("${setName}"): ` +
        `cannot locate @cleocode/core from "${import.meta.url}". ` +
        `Ensure @cleocode/core is installed (workspace or npm). ` +
        `Original error: ${(err as Error).message}`,
    );
  }
}
