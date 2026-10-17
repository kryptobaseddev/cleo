/**
 * Shared Drizzle schema-construction helpers (SOLID/DRY groundwork).
 *
 * This module hosts column-group and table factories that eliminate verbatim
 * duplication across the consolidated residency-split schema modules
 * (`cleo-project/`, `cleo-global/`, `cleo-shared/`). Factories here are
 * **physical-schema-preserving**: they emit exactly the same DDL the inline
 * definitions did, so applying them produces zero migration drift.
 *
 * @see .cleo/rcasd/adr-090-nexus-graph-residency-split.md §5 (SOLID/DRY groundwork)
 * @task T11543
 * @epic T11535
 * @saga T11242
 */

import { redactJsonText } from '@cleocode/utils';
import { customType, sqliteTable, text } from 'drizzle-orm/sqlite-core';

/**
 * The canonical two-column shape of a `*_schema_meta` key-value table:
 * `key` (`TEXT PRIMARY KEY`) + `value` (`TEXT NOT NULL`), in that order.
 *
 * Factored into a single builder so every domain's `*_schema_meta` table is
 * constructed from the identical column map — the source of the zero-drift
 * guarantee. Spread into {@link makeSchemaMetaTable}'s `sqliteTable` call.
 */
const schemaMetaColumns = {
  /** Config key. */
  key: text('key').primaryKey(),
  /** Config value. */
  value: text('value').notNull(),
} as const;

/**
 * Physical column shape of a canonical `*_schema_meta` key-value table.
 *
 * Derived from {@link makeSchemaMetaTable}'s return so the explicit table type
 * (column names, affinities, PK/NOT-NULL flags) stays in lockstep with the
 * factory body — no hand-maintained column generics to drift.
 */
export type SchemaMetaTable = ReturnType<typeof makeSchemaMetaTable>;

/**
 * Factory for the canonical schema-version key-value table.
 *
 * Every CLEO domain DB carries a `*_schema_meta` table with the byte-identical
 * `{ key TEXT PRIMARY KEY, value TEXT NOT NULL }` shape. This factory is the
 * single source of truth for that shape so the columns never drift apart across
 * domains. The emitted DDL is identical to the prior inline definitions.
 *
 * @param tableName Fully-qualified physical table name, e.g. `'nexus_schema_meta'`.
 * @returns A Drizzle SQLite table with `key` (PK) and `value` (NOT NULL) text columns.
 *
 * @example
 * ```ts
 * export const nexusSchemaMeta = makeSchemaMetaTable('nexus_schema_meta');
 * ```
 */
export function makeSchemaMetaTable(tableName: string) {
  return sqliteTable(tableName, schemaMetaColumns);
}

/**
 * A TEXT column that scrubs secrets on every Drizzle write (T13855).
 *
 * The audit tables record command params and responses verbatim, and
 * `tasks_audit_log` syncs, so `service connect --token …` put the token in the
 * cloud vault. Redacting in the column's `toDriver` covers every Drizzle
 * writer of the column at once: secret-named JSON fields and known credential
 * shapes become `[REDACTED]` (`redactJsonText`). The DDL is plain `text`,
 * identical to `text(name)`.
 *
 * @param name - The physical column name.
 * @returns A Drizzle column builder for the TEXT column.
 * @task T13855
 */
export const redactedText = (name: string) =>
  customType<{ data: string; driverData: string }>({
    dataType: () => 'text',
    toDriver: (value: string): string => redactJsonText(value),
  })(name);
