/**
 * Repair functions for fixable data integrity issues — SQLite era.
 *
 * Each function performs a direct Drizzle SQL update (no in-memory TaskFile mutation).
 * Used by both `upgrade` and `validate --fix`.
 *
 * @task T4862
 */

import { isNull, sql } from 'drizzle-orm';

/** A single repair action with status. */
export interface RepairAction {
  action: string;
  status: 'applied' | 'skipped' | 'preview';
  details: string;
}

/**
 * Set size='medium' on tasks that have no size value.
 * Operates directly on the SQLite tasks table.
 */
export async function repairMissingSizes(
  cwd: string | undefined,
  dryRun: boolean,
): Promise<RepairAction> {
  const { getDb } = await import('../store/sqlite.js');
  const { tasks } = await import('../store/schema.js');
  const db = await getDb(cwd);

  const affected = await db
    .select({ id: tasks.id })
    .from(tasks)
    .where(isNull(tasks.size));

  if (affected.length === 0) {
    return {
      action: 'fix_missing_sizes',
      status: 'skipped',
      details: 'No tasks missing size field',
    };
  }

  if (dryRun) {
    return {
      action: 'fix_missing_sizes',
      status: 'preview',
      details: `Would set size='medium' for ${affected.length} task(s)`,
    };
  }

  await db
    .update(tasks)
    .set({ size: 'medium' })
    .where(isNull(tasks.size));

  return {
    action: 'fix_missing_sizes',
    status: 'applied',
    details: `Set size='medium' for ${affected.length} task(s)`,
  };
}

/**
 * Set completedAt=now() on done/cancelled tasks that are missing a completedAt timestamp.
 * Operates directly on the SQLite tasks table.
 */
export async function repairMissingCompletedAt(
  cwd: string | undefined,
  dryRun: boolean,
): Promise<RepairAction> {
  const { getDb } = await import('../store/sqlite.js');
  const { tasks } = await import('../store/schema.js');
  const db = await getDb(cwd);

  const affected = await db
    .select({ id: tasks.id })
    .from(tasks)
    .where(
      sql`(${tasks.status} = 'done' OR ${tasks.status} = 'cancelled') AND ${tasks.completedAt} IS NULL`,
    );

  if (affected.length === 0) {
    return {
      action: 'fix_completed_at',
      status: 'skipped',
      details: 'No done/cancelled tasks missing completedAt',
    };
  }

  if (dryRun) {
    return {
      action: 'fix_completed_at',
      status: 'preview',
      details: `Would set completedAt for ${affected.length} done/cancelled task(s)`,
    };
  }

  const now = new Date().toISOString();
  await db
    .update(tasks)
    .set({ completedAt: now })
    .where(
      sql`(${tasks.status} = 'done' OR ${tasks.status} = 'cancelled') AND ${tasks.completedAt} IS NULL`,
    );

  return {
    action: 'fix_completed_at',
    status: 'applied',
    details: `Set completedAt for ${affected.length} done/cancelled task(s)`,
  };
}

/**
 * Run all repair functions.
 * Returns all actions taken (or previewed in dry-run mode).
 */
export async function runAllRepairs(
  cwd: string | undefined,
  dryRun: boolean,
): Promise<RepairAction[]> {
  const [sizes, completedAt] = await Promise.all([
    repairMissingSizes(cwd, dryRun),
    repairMissingCompletedAt(cwd, dryRun),
  ]);
  return [sizes, completedAt];
}
