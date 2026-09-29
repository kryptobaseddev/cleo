/**
 * Registry activity timestamps (T12512): "probed" and "opened" are different
 * facts and live in different columns.
 *
 * - `last_probed_at` — a health check, `nexus sync` or git state probe looked
 *   at the project. Says nothing about whether anyone uses it.
 * - `last_opened_at` — a real CLI command ran inside the project. Written at
 *   most once per {@link OPENED_WRITE_INTERVAL_MS}: a read decides, and only a
 *   stale value costs a primary-key update, so a read-only command does not
 *   take the write lock on every run.
 *
 * `last_seen` keeps its encounter meaning; neither function touches it.
 *
 * @task T12512
 * @epic T12496
 */

import { eq, inArray } from 'drizzle-orm';
import type { NodeSQLiteDatabase } from 'drizzle-orm/node-sqlite';
import { projectRegistry } from '../store/schema/nexus-schema.js';

/** Minimum interval between two `last_opened_at` writes for one project. */
export const OPENED_WRITE_INTERVAL_MS = 60_000;

/** Rows per `IN (...)` update (well under SQLite's bound-parameter limit). */
const PROBED_CHUNK = 500;

/** Registry handle subset the activity writers need. */
export type ProjectActivityHandle = Pick<NodeSQLiteDatabase, 'select' | 'update'>;

/**
 * Record that a health check, sync or git probe looked at these projects.
 *
 * @param db - Global registry handle.
 * @param projectIds - Probed project ids (duplicates are fine).
 * @param now - Probe instant.
 * @returns Number of registry rows updated.
 * @example
 * ```ts
 * markProjectsProbed(db, ['a1b2c3d4e5f6'], new Date());
 * ```
 */
export function markProjectsProbed(
  db: ProjectActivityHandle,
  projectIds: readonly string[],
  now: Date = new Date(),
): number {
  const ids = [...new Set(projectIds)];
  const at = now.toISOString();
  let changed = 0;
  for (let i = 0; i < ids.length; i += PROBED_CHUNK) {
    const chunk = ids.slice(i, i + PROBED_CHUNK);
    changed += Number(
      db
        .update(projectRegistry)
        .set({ lastProbedAt: at })
        .where(inArray(projectRegistry.projectId, chunk))
        .run().changes,
    );
  }
  return changed;
}

/**
 * Record real CLI use of a project, unless it was recorded within the last
 * {@link OPENED_WRITE_INTERVAL_MS}.
 *
 * @param db - Global registry handle.
 * @param projectId - The project the command ran in.
 * @param now - Command instant.
 * @returns `written`, `throttled`, or `unregistered` (no registry row).
 * @example
 * ```ts
 * markProjectOpened(db, 'a1b2c3d4e5f6');
 * ```
 */
export function markProjectOpened(
  db: ProjectActivityHandle,
  projectId: string,
  now: Date = new Date(),
): 'written' | 'throttled' | 'unregistered' {
  const row = db
    .select({ lastOpenedAt: projectRegistry.lastOpenedAt })
    .from(projectRegistry)
    .where(eq(projectRegistry.projectId, projectId))
    .get();
  if (row === undefined) return 'unregistered';
  const staleBefore = new Date(now.getTime() - OPENED_WRITE_INTERVAL_MS).toISOString();
  if (row.lastOpenedAt !== null && row.lastOpenedAt > staleBefore) return 'throttled';
  db.update(projectRegistry)
    .set({ lastOpenedAt: now.toISOString() })
    .where(eq(projectRegistry.projectId, projectId))
    .run();
  return 'written';
}
