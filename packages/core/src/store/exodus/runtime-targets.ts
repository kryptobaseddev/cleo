/**
 * Resolve each legacy table to the physical table the RUNTIME reads today.
 *
 * ## Why (T12346)
 *
 * The exodus table map (`table-name-map.ts`) names the CONSOLIDATED target —
 * `audit_log` → `tasks_audit_log`, `token_usage` → `tasks_token_usage`, … But
 * the runtime has not cut every table over. It binds the tasks domain through
 * `tasks-schema.ts`, which re-points only part of the legacy family at the
 * prefixed tables; `audit_log`, `token_usage`, `architecture_decisions`,
 * `attachments`, `schema_meta`, … are still read and written BARE. A reconcile
 * that copies a legacy `audit_log` row into `tasks_audit_log` preserves it where
 * no command will ever show it — which is not a reconcile.
 *
 * The answer is derived, never hand-written: for every drizzle table object in
 * the legacy bare schema module (`schema/index.ts`, whose physical names are the
 * legacy `tasks.db` names), the runtime target is the physical name of the
 * SAME export as the runtime binds it (`tasks-schema.ts`). When the runtime
 * moves another table to its prefixed twin, this follows automatically.
 *
 * Only the `tasks` source is re-derived; brain/conduit/global sources keep the
 * consolidated map, whose targets are already the tables their runtimes bind.
 *
 * @module
 * @task T12346
 */

import { getTableName, is } from 'drizzle-orm';
import { SQLiteTable } from 'drizzle-orm/sqlite-core';
import { LEGACY_FOLDS } from './column-transforms.js';
import { resolveConsolidatedTableName, type TableNameResolution } from './table-name-map.js';

/** Resolves one legacy table of one source to its copy target. */
export type TargetResolver = (sourceName: string, legacyTable: string) => TableNameResolution;

/**
 * Build a resolver that targets the tables the runtime reads today.
 *
 * @returns A {@link TargetResolver}: tasks-source tables go to the physical table
 *   the runtime binds for the same schema export; everything else (and any
 *   legacy table the runtime no longer binds) falls back to the consolidated map.
 * @task T12346
 */
export async function buildRuntimeTargetResolver(): Promise<TargetResolver> {
  const bare = await import('../schema/index.js');
  const runtime = await import('../tasks-schema.js');
  const runtimeByKey = new Map<string, string>();
  for (const [key, value] of Object.entries(runtime)) {
    if (is(value, SQLiteTable)) runtimeByKey.set(key, getTableName(value));
  }
  const runtimeByLegacyName = new Map<string, string>();
  for (const [key, value] of Object.entries(bare)) {
    if (!is(value, SQLiteTable)) continue;
    const target = runtimeByKey.get(key);
    if (target !== undefined) runtimeByLegacyName.set(getTableName(value), target);
  }
  return (sourceName, legacyTable) => {
    const consolidated = resolveConsolidatedTableName(sourceName, legacyTable);
    if (consolidated.kind === 'skip' || !sourceName.toLowerCase().startsWith('tasks'))
      return consolidated;
    const target = runtimeByLegacyName.get(LEGACY_FOLDS.get(legacyTable)?.into ?? legacyTable);
    return target === undefined ? consolidated : { kind: 'mapped', targetName: target };
  };
}
