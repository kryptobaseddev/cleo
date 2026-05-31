/**
 * Project-scope `cleo.db` — consolidated **telemetry** domain.
 *
 * Part of the consolidated PROJECT-scope `cleo.db` target shape authored for
 * SG-DB-SUBSTRATE-V2 (saga T11242, epic T11245/E2, task T11360). Target-shape
 * authoring only — physical names carry the `telemetry_` domain prefix (already
 * present in the source, so the idempotent prefixer is a no-op here: a table
 * already carrying a recognized domain prefix is NOT double-prefixed, per AC1).
 * The live runtime module `schema/telemetry-schema.ts` is unchanged until the
 * exodus migration (T11248) deploys this shape.
 *
 * ## E10 typing applied
 *
 * - **§4 timestamps:** `telemetry_events.timestamp` is the canonical TEXT
 *   ISO8601 form (`datetime('now')`); no epoch non-conformer in this domain.
 * - **No boolean / enum / JSON columns** — `exit_code` is a numeric LAFS code
 *   (not a 0/1 boolean flag), so it stays plain `integer` per the audit.
 *
 * @task T11360
 * @epic T11245
 * @saga T11242
 * @see docs/migration/sqlite-schema-canonical.md §1 (D1″) · §4
 * @see docs/migration/sqlite-schema-columns.json (per-column affinity SSoT)
 */

import { sql } from 'drizzle-orm';
import { index, integer, sqliteTable, text } from 'drizzle-orm/sqlite-core';

/**
 * `telemetry_events` — one row per command invocation captured by the
 * telemetry middleware (anonymous, opt-in). Already domain-prefixed; the
 * idempotent prefixer leaves the name as-is.
 *
 * @task T11360 (target shape) · T624 (original)
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
    /** LAFS exit code (0 = success, non-zero = failure). Numeric, not boolean. */
    exitCode: integer('exit_code').notNull().default(0),
    /** Wall-clock duration in milliseconds. */
    durationMs: integer('duration_ms').notNull(),
    /** Machine-readable error code when exit_code != 0. NULL on success. */
    errorCode: text('error_code'),
    /** ISO-8601 UTC instant of the invocation (canonical TEXT timestamp, §4). */
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

/**
 * `telemetry_schema_meta` — key-value schema-version tracking (single row).
 *
 * @task T11360 (target shape) · T624 (original)
 */
export const telemetrySchemaMeta = sqliteTable('telemetry_schema_meta', {
  /** Config key. */
  key: text('key').primaryKey(),
  /** Config value. */
  value: text('value').notNull(),
});

// === TYPE EXPORTS ===

/** Row type for `telemetry_events` SELECT queries (target shape). */
export type TelemetryEventRow = typeof telemetryEvents.$inferSelect;
/** Row type for `telemetry_events` INSERT operations (target shape). */
export type NewTelemetryEventRow = typeof telemetryEvents.$inferInsert;
/** Row type for `telemetry_schema_meta` SELECT queries (target shape). */
export type TelemetrySchemaMetaRow = typeof telemetrySchemaMeta.$inferSelect;
/** Row type for `telemetry_schema_meta` INSERT operations (target shape). */
export type NewTelemetrySchemaMetaRow = typeof telemetrySchemaMeta.$inferInsert;
