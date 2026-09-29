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
 * `last_seen` records identity and location writes to the registry row:
 * registration, a new or moved checkout, reconcile, rename and index stats.
 * It is NOT bumped on every command (the per-command encounter returns early
 * when the checkout is already current), so on its own it is not "last used".
 * Neither writer here touches it.
 *
 * ## Activity
 *
 * Any "recently active / recently used" decision reads ONE value:
 * {@link projectLastActivity} = max(`last_seen`, `last_opened_at`,
 * `last_probed_at`), or {@link projectLastActivitySql} in a query. Temp-project
 * GC, name disambiguation and the Studio project list all use it.
 *
 * @task T12512
 * @epic T12496
 */

import { eq, inArray, type SQL, sql } from 'drizzle-orm';
import type { NodeSQLiteDatabase } from 'drizzle-orm/node-sqlite';
import { projectRegistry } from '../store/schema/nexus-schema.js';

/** Minimum interval between two `last_opened_at` writes for one project. */
export const OPENED_WRITE_INTERVAL_MS = 60_000;

/** Registry timestamp columns that together make up a project's activity. */
export const ACTIVITY_COLUMNS = ['last_seen', 'last_opened_at', 'last_probed_at'] as const;

/**
 * Normalise a registry timestamp to ISO-8601 UTC so values written by
 * `datetime('now')` (`YYYY-MM-DD HH:MM:SS`, UTC) and by `toISOString()`
 * compare correctly.
 *
 * @param value - Stored timestamp, or `null`/`undefined`.
 * @returns An ISO-8601 string, or `null` when absent or unparseable.
 */
export function normalizeRegistryTimestamp(value: string | null | undefined): string | null {
  if (value === null || value === undefined || value.length === 0) return null;
  const iso = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}(\.\d+)?$/.test(value)
    ? `${value.replace(' ', 'T')}Z`
    : value;
  const ms = Date.parse(iso);
  return Number.isNaN(ms) ? null : new Date(ms).toISOString();
}

/**
 * A project's last activity: the newest of `lastSeen`, `lastOpenedAt` and
 * `lastProbedAt` (T12512). The single accessor for "recently active".
 *
 * @param p - Registry timestamps (the camel-case `NexusProject` fields).
 * @returns The newest as ISO-8601, or `null` when none parses.
 * @example
 * ```ts
 * projectLastActivity({ lastSeen: '2026-01-01 00:00:00', lastOpenedAt: '2026-09-29T10:00:00.000Z' });
 * // '2026-09-29T10:00:00.000Z'
 * ```
 */
export function projectLastActivity(p: {
  lastSeen: string | null | undefined;
  lastOpenedAt?: string | null;
  lastProbedAt?: string | null;
}): string | null {
  let newest: string | null = null;
  for (const v of [p.lastSeen, p.lastOpenedAt, p.lastProbedAt]) {
    const iso = normalizeRegistryTimestamp(v);
    if (iso !== null && (newest === null || iso > newest)) newest = iso;
  }
  return newest;
}

/**
 * SQL text for a project's last activity over `nexus_project_registry`
 * columns, for raw-SQL readers (Studio). Only the columns in `available` are
 * used, so a store not yet migrated (no `last_opened_at`) still reads.
 * Space-separated `datetime('now')` values are made comparable by `replace`.
 *
 * @param available - Column names present on the table.
 * @returns A SQL expression.
 */
export function projectLastActivitySqlText(available: ReadonlySet<string>): string {
  const parts = ACTIVITY_COLUMNS.filter((c) => available.has(c)).map(
    (c) => `coalesce(replace(${c}, ' ', 'T'), '')`,
  );
  if (parts.length === 0) return "''";
  return parts.length === 1 ? (parts[0] as string) : `max(${parts.join(', ')})`;
}

/**
 * Drizzle SQL for a project's last activity (every column exists on a
 * migrated store). Order by it, descending, for "most recently active first".
 */
export const projectLastActivitySql: SQL<string> = sql<string>`max(coalesce(replace(${projectRegistry.lastSeen}, ' ', 'T'), ''), coalesce(replace(${projectRegistry.lastOpenedAt}, ' ', 'T'), ''), coalesce(replace(${projectRegistry.lastProbedAt}, ' ', 'T'), ''))`;

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
