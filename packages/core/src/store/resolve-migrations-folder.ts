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
/**
 * Every migration lineage that can physically share a consolidated `cleo.db`
 * `__drizzle_migrations` journal (T11829 · SG-DB-SUBSTRATE-V2).
 *
 * The consolidated single-file-per-scope substrate has ONE shared journal per file
 * but is reconciled by every lineage whose tables coexist in that file. Each
 * lineage's `reconcileJournal` must treat the OTHER lineages' rows as known (not
 * orphans) — otherwise the journal never converges and every open re-thrashes the
 * WAL writer lock under `busy_timeout`, stacking 300-550 MB connection opens until
 * the host OOM-kills (the confirmed root cause).
 *
 * This is the SSoT for that union. It intentionally lists BOTH the project-scope
 * lineages (`drizzle-tasks`, `drizzle-cleo-project`, `drizzle-nexus`,
 * `drizzle-brain`, `drizzle-conduit`) and the global-scope lineages
 * (`drizzle-cleo-global`, `drizzle-agent-registry`, `drizzle-skills`,
 * `drizzle-telemetry`). Over-inclusion is SAFE and conservative: a sibling whose
 * hash never appears in a given file's journal contributes nothing, and a hash that
 * DOES appear can only be a legitimately-applied migration of that lineage — so
 * adding it to the union only ever PREVENTS a wrongful deletion, never causes one.
 * Listing a lineage absent from a given install is harmless —
 * {@link resolveConsolidatedJournalSiblings}'s caller skips folders that read empty.
 */
export const CONSOLIDATED_JOURNAL_LINEAGES: readonly string[] = [
  'drizzle-tasks',
  'drizzle-cleo-project',
  'drizzle-nexus',
  'drizzle-brain',
  'drizzle-conduit',
  'drizzle-cleo-global',
  'drizzle-agent-registry',
  'drizzle-skills',
  'drizzle-telemetry',
] as const;

/**
 * Resolve the SIBLING migration folders that share the consolidated `cleo.db`
 * journal with the given lineage (T11829).
 *
 * Pass the result as `siblingMigrationsFolders` to `reconcileJournal` so its
 * cross-lineage orphan-deletion guard knows every hash that legitimately belongs
 * to a coexisting lineage. The caller's OWN folder is excluded from the result.
 *
 * @param ownSetName - The lineage doing the reconcile, e.g. `'drizzle-tasks'`.
 * @returns Absolute paths to the OTHER consolidated-journal lineage folders.
 *
 * @example
 * ```ts
 * reconcileJournal(nativeDb, folder, 'tasks', 'sqlite',
 *   resolveConsolidatedJournalSiblings('drizzle-tasks'));
 * ```
 */
export function resolveConsolidatedJournalSiblings(ownSetName: string): string[] {
  return CONSOLIDATED_JOURNAL_LINEAGES.filter((name) => name !== ownSetName).map((name) =>
    resolveCorePackageMigrationsFolder(name),
  );
}

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
