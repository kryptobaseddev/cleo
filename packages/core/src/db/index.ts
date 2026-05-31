/**
 * `@cleocode/core/db` subpath export — typed dual-scope SQLite client.
 *
 * This barrel re-exports the public API of the dual-scope DB chokepoint
 * implemented in `packages/core/src/store/dual-scope-db.ts` as the
 * `@cleocode/core/db` subpath module.
 *
 * ## What is exported
 *
 * - {@link openDualScopeDb} — open (or re-use) the consolidated `cleo.db`
 *   for either scope.
 * - {@link DualScopeDbHandle} — handle type returned by `openDualScopeDb`.
 * - {@link DualScope} — the `'project' | 'global'` scope union.
 * - {@link CleoProjectDb} — typed Drizzle handle for the project scope.
 * - {@link CleoGlobalDb} — typed Drizzle handle for the global scope.
 * - {@link resolveDualScopeDbPath} — resolve the absolute DB file path.
 * - {@link insertIdempotent} — retry-safe insert (ON CONFLICT DO NOTHING).
 * - {@link upsertIdempotent} — retry-safe upsert (ON CONFLICT DO UPDATE).
 * - {@link _resetDualScopeDbCache} — test helper: clear singleton cache.
 *
 * ## Usage
 *
 * ```ts
 * import { openDualScopeDb, insertIdempotent } from '@cleocode/core/db';
 *
 * const proj = await openDualScopeDb('project', process.cwd());
 * const global = await openDualScopeDb('global');
 * ```
 *
 * @packageDocumentation
 * @task T11514 (E4-T3)
 * @epic T11247 (E4)
 * @saga T11242 (SG-DB-SUBSTRATE-V2)
 */

export {
  _resetDualScopeDbCache,
  type CleoGlobalDb,
  type CleoProjectDb,
  type DualScope,
  type DualScopeDbHandle,
  insertIdempotent,
  openDualScopeDb,
  resolveDualScopeDbPath,
  upsertIdempotent,
} from '../store/dual-scope-db.js';
