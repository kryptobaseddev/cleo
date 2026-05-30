/**
 * Consolidated 5-domain Pattern A schema for the SG-DB-SUBSTRATE-V2 spike.
 *
 * Validates the architectural lock decision (D1′): a SINGLE SQLite file per
 * scope (project, global) with domain-prefixed tables
 * (`tasks_*`, `brain_*`, `conduit_*`, `docs_*`, `telemetry_*`) — Pattern A —
 * with native cross-domain foreign keys. ATTACH is REJECTED: because every
 * table lives in one file, FKs span domains natively and `PRAGMA
 * foreign_key_check` can enforce referential integrity across the whole scope
 * (impossible reliably across ATTACH boundaries).
 *
 * Defined as drizzle-orm/sqlite-core tables so the same schema drives both the
 * raw-`node:sqlite` durability/concurrency harnesses (via emitted DDL) and the
 * Drizzle idempotency micro-bench (via the query builder + `onConflictDoNothing`).
 *
 * @task T11244
 * @task T11324
 * @saga T11242
 */
import { integer, sqliteTable, text } from 'drizzle-orm/sqlite-core';

/**
 * `tasks_task` — the root domain row. Every other domain references a task,
 * exercising cross-domain FK edges in the single consolidated file.
 */
export const tasksTask = sqliteTable('tasks_task', {
  id: text('id').primaryKey(),
  title: text('title').notNull(),
  status: text('status').notNull().default('pending'),
  createdAt: integer('created_at').notNull(),
});

/**
 * `brain_memory` — BRAIN domain. FK → `tasks_task.id` (cross-domain edge 1).
 */
export const brainMemory = sqliteTable('brain_memory', {
  id: text('id').primaryKey(),
  taskId: text('task_id')
    .notNull()
    .references(() => tasksTask.id),
  observation: text('observation').notNull(),
});

/**
 * `conduit_event` — conduit domain. FK → `tasks_task.id` (cross-domain edge 2).
 * Carries the idempotency key column used by the Pattern A idempotency bench.
 */
export const conduitEvent = sqliteTable('conduit_event', {
  /**
   * Pattern A idempotency key: a TEXT PRIMARY KEY whose UNIQUE constraint is
   * the conflict target for `onConflictDoNothing`. NO separate ledger table.
   */
  idempotencyKey: text('idempotency_key').primaryKey(),
  taskId: text('task_id')
    .notNull()
    .references(() => tasksTask.id),
  payload: text('payload').notNull(),
  createdAt: integer('created_at').notNull(),
});

/**
 * `docs_attachment` — docs domain. FK → `tasks_task.id` (cross-domain edge 3).
 */
export const docsAttachment = sqliteTable('docs_attachment', {
  id: text('id').primaryKey(),
  taskId: text('task_id')
    .notNull()
    .references(() => tasksTask.id),
  slug: text('slug').notNull().unique(),
});

/**
 * `telemetry_span` — telemetry domain. FK → `tasks_task.id` (cross-domain
 * edge 4). All five domains live in one file; the FK graph is a single
 * connected component the SQLite planner enforces natively.
 */
export const telemetrySpan = sqliteTable('telemetry_span', {
  id: text('id').primaryKey(),
  taskId: text('task_id')
    .notNull()
    .references(() => tasksTask.id),
  durationMs: integer('duration_ms').notNull(),
});

/**
 * Raw DDL for the consolidated 5-domain schema, used by the harnesses that
 * open `node:sqlite` directly (durability/concurrency) rather than through
 * Drizzle. Mirrors the table definitions above byte-for-byte in column
 * order/names so both paths exercise the identical physical schema.
 *
 * Cross-domain FK edges (all → `tasks_task.id`):
 *   brain_memory, conduit_event, docs_attachment, telemetry_span.
 */
export const CONSOLIDATED_DDL = `
CREATE TABLE IF NOT EXISTS tasks_task (
  id          TEXT PRIMARY KEY,
  title       TEXT NOT NULL,
  status      TEXT NOT NULL DEFAULT 'pending',
  created_at  INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS brain_memory (
  id          TEXT PRIMARY KEY,
  task_id     TEXT NOT NULL REFERENCES tasks_task(id),
  observation TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS conduit_event (
  idempotency_key TEXT PRIMARY KEY,
  task_id         TEXT NOT NULL REFERENCES tasks_task(id),
  payload         TEXT NOT NULL,
  created_at      INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS docs_attachment (
  id      TEXT PRIMARY KEY,
  task_id TEXT NOT NULL REFERENCES tasks_task(id),
  slug    TEXT NOT NULL UNIQUE
);
CREATE TABLE IF NOT EXISTS telemetry_span (
  id          TEXT PRIMARY KEY,
  task_id     TEXT NOT NULL REFERENCES tasks_task(id),
  duration_ms INTEGER NOT NULL
);
` as const;

/**
 * Minimal single-table DDL used by the concurrency benchmark — a writer-only
 * append table that isolates raw commit latency from FK-resolution cost.
 */
export const WRITER_BENCH_DDL = `
CREATE TABLE IF NOT EXISTS telemetry_span (
  id          TEXT PRIMARY KEY,
  task_id     TEXT NOT NULL,
  duration_ms INTEGER NOT NULL,
  payload     TEXT NOT NULL
);
` as const;
