/**
 * What a remote delete of an FK parent does to its remaining sync-set
 * children (T12344 PR-4; journal spec §3.2 "FK actions", R5-7, NEW-4).
 *
 * The origin journals its cascaded child deletes before the parent's D, so
 * normally no child remains when the parent's D applies. A child that does
 * remain was written concurrently, and SQLite would cascade it away with no
 * op. The parent table's policy decides instead:
 *
 * - `conflict` (tasks, sessions): the parent's D is not applied; it becomes a
 *   revivable void plus a `delete-with-live-children` conflict listing the
 *   children. Resolutions are ordinary writes.
 * - `cascade-with-ops` (hard deletes by design: purges, GC paths): every
 *   replica deletes the remaining children deterministically inside the
 *   apply frame, with intents, so nothing is re-emitted.
 *
 * Only `ON DELETE CASCADE` children count: a `SET NULL` child survives (its
 * cleared column is recorded as an apply intent), and a `RESTRICT` child
 * makes the delete fail, which the applier turns into a guard conflict.
 * Every sync-set FK parent is declared here; a test fails on an undeclared
 * one.
 *
 * @module store/sync/apply/parent-delete
 * @task T12344
 */

/** A parent table's remote-delete policy. */
export type ParentDeletePolicy = 'conflict' | 'cascade-with-ops';

/** The policy of every sync-set table that is an FK parent of sync-set children. */
export const ON_REMOTE_PARENT_DELETE: Readonly<Record<string, ParentDeletePolicy>> = {
  tasks_tasks: 'conflict',
  tasks_sessions: 'conflict',
};

/**
 * The policy for a parent table; `conflict` (never lose a row silently) for
 * a table the registry does not name.
 *
 * @param table - The parent table.
 * @returns Its policy.
 */
export function parentDeletePolicy(table: string): ParentDeletePolicy {
  return ON_REMOTE_PARENT_DELETE[table] ?? 'conflict';
}
