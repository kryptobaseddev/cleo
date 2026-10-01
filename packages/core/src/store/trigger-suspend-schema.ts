/**
 * Drizzle ORM schema for `cleo_trigger_suspend` (T12819, journal spec §3.5
 * Rule 4, C2).
 *
 * One row per suspended trigger class (`capture`, `guard`, `side-effect`, or
 * `all`), present only inside a rebase frame's own transaction. The owned
 * guard and side-effect triggers read it in their `WHEN NOT EXISTS` clause.
 *
 * Schema-owned and never dropped. It is created by the drizzle-cleo-project
 * migration `20260930170000_t12819-trigger-suspend-clause`, and the open pass
 * recreates it (IF NOT EXISTS) before migrations. The value CHECK lives in
 * that migration's raw SQL, which the typed API does not express.
 *
 * @module
 * @task T12819
 * @see ./sync/trigger-classes.ts — classes, clause, step 0 and verification
 */

import { sqliteTable, text } from 'drizzle-orm/sqlite-core';

/** Physical name of the flag table. */
export const TRIGGER_SUSPEND_TABLE_NAME = 'cleo_trigger_suspend';

/** `cleo_trigger_suspend(scope TEXT PRIMARY KEY)`. */
export const cleoTriggerSuspend = sqliteTable(TRIGGER_SUSPEND_TABLE_NAME, {
  scope: text('scope').primaryKey().notNull(),
});
