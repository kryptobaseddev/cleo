/**
 * Global-scope `cleo.db` — consolidated **telemetry** domain.
 *
 * Part of the consolidated GLOBAL-scope `cleo.db` target shape. Per ADR-090 §2.3
 * the two telemetry tables (`telemetry_events`, `telemetry_schema_meta`) are
 * machine-wide command telemetry — a CROSS-PROJECT signal — so they reside in the
 * GLOBAL `cleo.db` (`$XDG_DATA_HOME/cleo/cleo.db`), not the per-project file. They
 * were relocated here from `cleo-project/telemetry.ts` by T11540 (the deferred
 * residency move recorded in ADR-090 §2.3); the physical DDL is unchanged so the
 * exodus cutover (T11248) emits zero drift versus the prior project-scope shape.
 *
 * Physical names carry the `telemetry_` domain prefix (already present in the
 * source, so the idempotent prefixer is a no-op here: a table already carrying a
 * recognized domain prefix is NOT double-prefixed, per AC1). The live runtime
 * module `schema/telemetry-schema.ts` (the standalone, already-global
 * `telemetry.db`) is unchanged until the exodus migration deploys this shape.
 *
 * ## E10 typing applied
 *
 * - **§4 timestamps:** `telemetry_events.timestamp` is the canonical TEXT
 *   ISO8601 form (`datetime('now')`); no epoch non-conformer in this domain.
 * - **No boolean / enum / JSON columns** — `exit_code` is a numeric LAFS code
 *   (not a 0/1 boolean flag), so it stays plain `integer` per the audit.
 * - **`telemetry_schema_meta`** is the canonical two-column KV shape, so it is
 *   built from the shared {@link makeSchemaMetaTable} factory (T11543) — the
 *   single source of the `{ key TEXT PK, value TEXT NOT NULL }` DDL across every
 *   domain. The emitted DDL is byte-identical to the prior inline definition.
 *
 * @task T11540
 * @epic T11535
 * @saga T11242
 * @see .cleo/rcasd/adr-090-nexus-graph-residency-split.md §2.3 (telemetry → GLOBAL)
 * @see ../schema-utils.ts — re-exported as {@link makeSchemaMetaTable} (T11543 factory)
 * @see docs/migration/sqlite-schema-canonical.md §1 (D1″) · §4
 * @see docs/migration/sqlite-schema-columns.json (per-column affinity SSoT)
 */

import { sql } from 'drizzle-orm';
import { index, integer, sqliteTable, text } from 'drizzle-orm/sqlite-core';
import { makeSchemaMetaTable } from '../schema-utils.js';

/**
 * `telemetry_events` — one row per command invocation captured by the
 * telemetry middleware (anonymous, opt-in). Already domain-prefixed; the
 * idempotent prefixer leaves the name as-is.
 *
 * @task T11540 (residency move · target shape) · T11360 (prior project-scope authoring) · T624 (original)
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
 * Built from the shared {@link makeSchemaMetaTable} factory (T11543) so the
 * canonical `{ key TEXT PRIMARY KEY, value TEXT NOT NULL }` shape never drifts
 * across domains; the emitted DDL is identical to the prior inline definition.
 *
 * @task T11540 (residency move · target shape) · T11543 (factory) · T624 (original)
 */
export const telemetrySchemaMeta = makeSchemaMetaTable('telemetry_schema_meta');

// === TYPE EXPORTS ===

/** Row type for `telemetry_events` SELECT queries (target shape). */
export type TelemetryEventRow = typeof telemetryEvents.$inferSelect;
/** Row type for `telemetry_events` INSERT operations (target shape). */
export type NewTelemetryEventRow = typeof telemetryEvents.$inferInsert;
/** Row type for `telemetry_schema_meta` SELECT queries (target shape). */
export type TelemetrySchemaMetaRow = typeof telemetrySchemaMeta.$inferSelect;
/** Row type for `telemetry_schema_meta` INSERT operations (target shape). */
export type NewTelemetrySchemaMetaRow = typeof telemetrySchemaMeta.$inferInsert;
