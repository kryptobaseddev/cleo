/**
 * Drizzle ORM schema for CLEO telemetry.db (SQLite via node:sqlite + sqlite-proxy).
 *
 * Tables: telemetry_events, telemetry_schema_meta
 *
 * Stores anonymous, opt-in command telemetry for self-improvement analysis.
 * Tracks which commands run, how fast they are, and whether they succeed.
 * Telemetry is DISABLED by default; users must run `cleo diagnostics enable`.
 *
 * @task T624
 */

import { sql } from 'drizzle-orm';
import { index, integer, sqliteTable, text } from 'drizzle-orm/sqlite-core';

// === TELEMETRY_EVENTS TABLE ===

/**
 * One row per command invocation captured by the telemetry middleware.
 *
 * Fields are intentionally minimal — no params, no output, no user data.
 * Only the shape of what was invoked and its outcome are stored.
 */
export const telemetryEvents = sqliteTable(
  'telemetry_events',
  {
    /** UUID primary key. */
    id: text('id').primaryKey(),
    /** Anonymous install identifier (UUIDv4, generated once on first enable). */
    anonymousId: text('anonymous_id').notNull(),
    /** Canonical domain (e.g. "tasks", "session", "memory", "admin"). */
    domain: text('domain').notNull(),
    /** CQRS gateway ("query" or "mutate"). */
    gateway: text('gateway').notNull(),
    /** Operation name (e.g. "show", "add", "complete"). */
    operation: text('operation').notNull(),
    /** Composed command string "{domain}.{operation}" for easy grouping. */
    command: text('command').notNull(),
    /** LAFS exit code (0 = success, non-zero = failure). */
    exitCode: integer('exit_code').notNull().default(0),
    /** Wall-clock duration in milliseconds. */
    durationMs: integer('duration_ms').notNull(),
    /** Machine-readable error code when exit_code != 0. NULL on success. */
    errorCode: text('error_code'),
    /** ISO-8601 timestamp of the invocation. */
    timestamp: text('timestamp').notNull().default(sql`(datetime('now'))`),
  },
  (table) => [
    index('idx_telemetry_command').on(table.command),
    index('idx_telemetry_domain').on(table.domain),
    index('idx_telemetry_exit_code').on(table.exitCode),
    index('idx_telemetry_timestamp').on(table.timestamp),
    index('idx_telemetry_duration').on(table.durationMs),
  ],
);

// === TELEMETRY_SCHEMA_META TABLE ===

/**
 * Key-value store for schema version tracking.
 * Single row with key='schema_version' on first migration.
 */
export const telemetrySchemaMeta = sqliteTable('telemetry_schema_meta', {
  /** Config key. */
  key: text('key').primaryKey(),
  /** Config value. */
  value: text('value').notNull(),
});
