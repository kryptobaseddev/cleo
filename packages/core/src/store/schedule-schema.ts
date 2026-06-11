/**
 * Drizzle ORM schema for the **cron / todo schedule** table (`schedules`) — the
 * durable sink for recurring-task schedules registered by the `cron_schedule`
 * agent tool (T11962 · under T11679 · M7 · epic T11456).
 *
 * One row per recurring schedule: a cron expression plus the task TEMPLATE
 * (title / description) materialized on each fire, an `enabled` flag, and
 * creation/update timestamps. The `cron_schedule` agent tool
 * ({@link import('../tools/schedule-agent-tools.js')}) registers a row through the
 * leased Gate-3 accessor ({@link import('./schedule-store.js')}) so it persists
 * WITHOUT a running daemon (T11950 AC3); a future daemon scheduler consumes the
 * SAME table as a separate reader (T11962 AC4).
 *
 * ## Pure runtime infrastructure (NOT the exodus target shape)
 *
 * Like `_writer_leases` (T11627), `pi_session_*` (T11899), and `selfimprove_dhq`
 * (T11911), this table is co-located inside EACH scope's consolidated `cleo.db`
 * (project + global) via the `drizzle-cleo-project` / `drizzle-cleo-global`
 * migration sets — so the two lineages produce the SAME migration hash and the
 * consolidated single-file journal converges across both
 * (CONSOLIDATED_JOURNAL_LINEAGES cross-lineage guard, T11829). It is NOT part of
 * the exodus target shape under `schema/cleo-project/`, so the consolidated
 * schema-parity gate (T11364) does not re-derive its CHECK set — exactly the
 * runtime-infrastructure precedent.
 *
 * ## E10 typing
 *
 * TEXT ISO-8601 timestamps (`created_at` / `updated_at`); a typed boolean
 * (`enabled`, `integer({ mode: 'boolean' })` → CHECK IN (0,1)). No JSON columns —
 * the task template is two plain TEXT columns (title + nullable description).
 *
 * @module
 * @task T11962
 * @epic T11679
 * @see ./schedule-store.ts — the Gate-3 accessor over this table
 * @see ./selfimprove-dhq-schema.ts — the runtime-infrastructure-table precedent this mirrors
 * @see ../../migrations/drizzle-cleo-project — project migration (CREATE TABLE schedules)
 * @see ../../migrations/drizzle-cleo-global — global migration (byte-identical, journal convergence)
 */

import { sql } from 'drizzle-orm';
import { index, integer, sqliteTable, text, unique } from 'drizzle-orm/sqlite-core';

/**
 * The physical name of the schedule table. Exported so the accessor and tests all
 * reference one source of truth.
 */
export const SCHEDULES_TABLE = 'schedules' as const;

/**
 * `schedules` — one row per recurring (cron) task schedule.
 *
 * `cronExpr` is the recurrence (a standard 5-field cron expression); `title` /
 * `description` are the task template materialized on each fire; `enabled` toggles
 * whether the daemon scheduler (a separate consumer, AC4) should fire it. The row
 * is written by the leased accessor ({@link import('./schedule-store.js')}) — the
 * `cron_schedule` agent tool delegates to it daemon-OFF.
 *
 * @task T11962
 */
export const schedules = sqliteTable(
  SCHEDULES_TABLE,
  {
    /** Surrogate primary key (autoincrement via INTEGER PRIMARY KEY rowid alias). */
    id: integer('id').primaryKey(),
    /** Stable opaque schedule handle (`sched-<token>`) returned to the tool caller. */
    scheduleId: text('schedule_id').notNull(),
    /** The recurrence — a standard 5-field cron expression (e.g. `'0 9 * * 1'`). */
    cronExpr: text('cron_expr').notNull(),
    /** The title of the task created on each fire (the template). */
    title: text('title').notNull(),
    /** Optional description for the task created on each fire. */
    description: text('description'),
    /**
     * Whether the daemon scheduler should fire this schedule. Typed boolean
     * (CHECK IN (0,1)); defaults `true` so a freshly-registered schedule is live.
     */
    enabled: integer('enabled', { mode: 'boolean' }).notNull().default(true),
    /** ISO-8601 UTC creation instant. Defaults to write time. */
    createdAt: text('created_at').notNull().default(sql`(datetime('now'))`),
    /** ISO-8601 UTC last-update instant. Defaults to write time; bumped on mutation. */
    updatedAt: text('updated_at').notNull().default(sql`(datetime('now'))`),
  },
  (table) => [
    // `schedule_id` is the opaque handle the accessor looks up / removes by — unique.
    unique('ux_schedules_schedule_id').on(table.scheduleId),
    // Lookup index — the daemon scheduler enumerates enabled schedules.
    index('ix_schedules_enabled').on(table.enabled),
  ],
);

/** Row type for `schedules` SELECT queries. */
export type ScheduleRow = typeof schedules.$inferSelect;
/** Row type for `schedules` INSERT operations. */
export type NewScheduleRow = typeof schedules.$inferInsert;
