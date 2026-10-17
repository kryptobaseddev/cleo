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

/** A transform applied to a TEXT column's value before it is stored. */
export type ColumnTransform = (value: string) => string;

/** The audit text columns that record command params and responses. */
const AUDIT_TEXT_TRANSFORMS: Readonly<Record<string, ColumnTransform>> = {
  details_json: redactJsonText,
  before_json: redactJsonText,
  after_json: redactJsonText,
  error_message: redactJsonText,
};

/**
 * Every column whose value is transformed before it is stored, by table
 * (T13861): the SSoT for both the Drizzle {@link redactedText} column and the
 * sync apply path (apply write API, received rows, conflict and reconcile
 * comparisons), so a pulled segment stores and compares the same value a
 * local write would.
 */
export const COLUMN_TRANSFORMS: Readonly<
  Record<string, Readonly<Record<string, ColumnTransform>>>
> = {
  tasks_audit_log: AUDIT_TEXT_TRANSFORMS,
  audit_log: AUDIT_TEXT_TRANSFORMS,
  nexus_audit_log: {
    details_json: redactJsonText,
    error_message: redactJsonText,
  },
};

/**
 * A value as `table.column` stores it: the column's {@link COLUMN_TRANSFORMS}
 * entry applied to a string, anything else unchanged.
 *
 * @param table - The physical table name.
 * @param column - The physical column name.
 * @param value - The value to be written or compared.
 * @returns The value as stored.
 * @task T13861
 */
export function transformColumnValue<V>(table: string, column: string, value: V): V | string {
  const transform = COLUMN_TRANSFORMS[table]?.[column];
  return transform !== undefined && typeof value === 'string' ? transform(value) : value;
}

/**
 * A row's values as `table` stores them ({@link transformColumnValue} per
 * column). Returns the input object itself when the table has no transforms.
 *
 * @param table - The physical table name.
 * @param values - Column → value.
 * @returns Column → stored value.
 * @task T13861
 */
export function transformColumnValues<V>(
  table: string,
  values: Readonly<Record<string, V>>,
): Readonly<Record<string, V | string>> {
  const transforms = COLUMN_TRANSFORMS[table];
  if (transforms === undefined) return values;
  const out: Record<string, V | string> = {};
  for (const [column, value] of Object.entries(values)) {
    out[column] = transformColumnValue(table, column, value);
  }
  return out;
}

/**
 * A TEXT column that scrubs secrets on every Drizzle write (T13855).
 *
 * The audit tables record command params and responses verbatim, and
 * `tasks_audit_log` syncs, so `service connect --token …` put the token in the
 * cloud vault. Redacting in the column's `toDriver` covers every Drizzle
 * writer of the column at once with the transform {@link COLUMN_TRANSFORMS}
 * names for it, the same one the sync apply path uses. The DDL is plain
 * `text`, identical to `text(name)`.
 *
 * @param table - The physical table name (a {@link COLUMN_TRANSFORMS} key).
 * @param name - The physical column name.
 * @returns A Drizzle column builder for the TEXT column.
 * @throws {Error} When the column has no transform.
 * @task T13855
 */
export const redactedText = (table: string, name: string) => {
  const transform = COLUMN_TRANSFORMS[table]?.[name];
  if (transform === undefined) throw new Error(`redactedText: ${table}.${name} has no transform`);
  return customType<{ data: string; driverData: string }>({
    dataType: () => 'text',
    toDriver: transform,
  })(name);
};
