/**
 * SQLite schema feature expressiveness matrix for CLEO's Drizzle schema layer.
 *
 * This matrix is intentionally code, not prose-only documentation: PM-Core V2
 * planning can import it, tests can lock it, and future schema work has a small
 * SSoT for deciding whether an invariant belongs in TypeScript Drizzle schema or
 * in a hand-written SQL migration.
 *
 * Scope: SQLite DDL features used or plausibly needed by CLEO tasks.db and sibling
 * stores while the repo is pinned to `drizzle-orm@1.0.0-beta.22-ec7b61d` and
 * `drizzle-kit@1.0.0-beta.19-d95b7a4`.
 *
 * @task T10567
 */

/** Expressiveness class for a SQLite DDL feature in CLEO's schema workflow. */
export type SqliteFeatureExpressiveness =
  | 'schema-supported'
  | 'schema-supported-with-sql-template'
  | 'raw-sql-required'
  | 'dual-source-required';

/** SQLite DDL capability groups covered by the expressiveness matrix. */
export type SqliteFeatureGroup = 'index' | 'constraint' | 'programmability' | 'column';

/**
 * A single SQLite feature classification entry.
 *
 * `drizzleSchemaPath` states whether the TypeScript schema can be the authoring
 * surface. `rawSqlPath` states whether hand-written migration SQL remains needed
 * for first-class SQLite semantics or drizzle-kit gaps.
 */
export interface SqliteFeatureExpressivenessEntry {
  /** Stable machine key used by tests and downstream PM-Core consumers. */
  readonly key: string;
  /** Feature family for grouping the matrix. */
  readonly group: SqliteFeatureGroup;
  /** Human-facing SQLite feature label. */
  readonly feature: string;
  /** Classification for CLEO's current Drizzle + SQLite migration workflow. */
  readonly expressiveness: SqliteFeatureExpressiveness;
  /** How the feature is represented, if at all, in Drizzle schema TypeScript. */
  readonly drizzleSchemaPath: string;
  /** How the feature is represented in migration SQL. */
  readonly rawSqlPath: string;
  /** CLEO-local note that explains why this classification exists. */
  readonly cleoGuidance: string;
}

/**
 * SQLite feature expressiveness matrix for Drizzle schema TypeScript versus raw
 * SQL migrations.
 */
export const SQLITE_FEATURE_EXPRESSIVENESS_MATRIX = [
  {
    key: 'index.plain',
    group: 'index',
    feature: 'Plain single-column index',
    expressiveness: 'schema-supported',
    drizzleSchemaPath: "index('idx_name').on(table.column)",
    rawSqlPath: 'Generated or hand-written CREATE INDEX is equivalent.',
    cleoGuidance: 'Prefer Drizzle schema for ordinary lookup indexes.',
  },
  {
    key: 'index.composite',
    group: 'index',
    feature: 'Composite multi-column index',
    expressiveness: 'schema-supported',
    drizzleSchemaPath: "index('idx_name').on(table.columnA, table.columnB)",
    rawSqlPath: 'Generated or hand-written CREATE INDEX over the same ordered column list.',
    cleoGuidance: 'Prefer Drizzle schema when every indexed term is a table column.',
  },
  {
    key: 'index.unique',
    group: 'index',
    feature: 'Unique index or unique constraint',
    expressiveness: 'schema-supported',
    drizzleSchemaPath: "uniqueIndex('uq_name').on(...) or unique('uq_name').on(...)",
    rawSqlPath: 'Generated or hand-written CREATE UNIQUE INDEX / UNIQUE constraint.',
    cleoGuidance: 'Prefer Drizzle schema for uniqueness invariants that map to columns.',
  },
  {
    key: 'index.partial',
    group: 'index',
    feature: 'Partial index with WHERE predicate',
    expressiveness: 'schema-supported-with-sql-template',
    drizzleSchemaPath: "index('idx_name').on(...).where(sql`predicate`)",
    rawSqlPath:
      'Hand-written SQL remains acceptable for predicates drizzle-kit cannot diff safely.',
    cleoGuidance:
      'Schema expression is available in current CLEO code; keep SQL migration comments when predicates are complex or historically raw-SQL only.',
  },
  {
    key: 'index.expression',
    group: 'index',
    feature: 'Expression index',
    expressiveness: 'schema-supported-with-sql-template',
    drizzleSchemaPath: "index('idx_name').on(sql template expression such as date(created_at))",
    rawSqlPath: 'CREATE INDEX idx_name ON table_name (expression).',
    cleoGuidance:
      'Use Drizzle only when the expression is stable and covered by tests; otherwise prefer raw SQL with an adjacent schema comment.',
  },
  {
    key: 'constraint.check',
    group: 'constraint',
    feature: 'CHECK constraint',
    expressiveness: 'dual-source-required',
    drizzleSchemaPath:
      'Drizzle sqlite-core exposes table-level CHECK builders, but CLEO enum/invariant checks are often migration-owned.',
    rawSqlPath: 'CHECK (...) in CREATE TABLE or table rebuild migration.',
    cleoGuidance:
      'Document every CHECK that is not visible beside the relevant TypeScript field; migration SQL is still the enforcement SSoT for existing tables.',
  },
  {
    key: 'constraint.foreign-key',
    group: 'constraint',
    feature: 'Foreign key constraint',
    expressiveness: 'schema-supported',
    drizzleSchemaPath:
      "column.references(() => other.id, { onDelete: 'cascade' }) or foreignKey(...)",
    rawSqlPath: 'REFERENCES target(column) with ON DELETE/UPDATE actions in CREATE TABLE.',
    cleoGuidance: 'Prefer Drizzle schema for FK shape, then keep migrations parity-tested.',
  },
  {
    key: 'programmability.trigger',
    group: 'programmability',
    feature: 'Trigger',
    expressiveness: 'raw-sql-required',
    drizzleSchemaPath: 'No first-class Drizzle table-builder construct for SQLite triggers.',
    rawSqlPath: 'CREATE TRIGGER ... BEGIN ... END in hand-written migration SQL.',
    cleoGuidance:
      'Triggers must live in raw SQL migrations with tests proving fresh-db and upgrade behavior.',
  },
  {
    key: 'column.generated',
    group: 'column',
    feature: 'Generated column',
    expressiveness: 'raw-sql-required',
    drizzleSchemaPath:
      'Do not rely on schema TypeScript as the authoritative migration surface until generated-column diffing is proven in this repo.',
    rawSqlPath: 'column_name TYPE GENERATED ALWAYS AS (expression) VIRTUAL|STORED.',
    cleoGuidance:
      'Use raw SQL plus a TypeScript schema documentation comment for generated columns; add parity tests before exposing as a typed field.',
  },
] as const satisfies readonly SqliteFeatureExpressivenessEntry[];

/**
 * Documentation gaps in existing schema TypeScript that future schema work should
 * close when raw SQL carries more semantics than the Drizzle table declaration.
 */
export const SQLITE_SCHEMA_TS_DOCUMENTATION_GAPS = [
  {
    key: 'gap.check-constraints',
    title: 'CHECK constraints are not consistently documented beside TS fields',
    guidance:
      'When a migration owns enum or cross-column CHECK logic, add a nearby field/table comment naming the migration and invariant.',
  },
  {
    key: 'gap.raw-sql-triggers',
    title: 'Triggers have no TypeScript schema anchor',
    guidance:
      'For any CREATE TRIGGER migration, add a schema comment or exported metadata entry describing trigger name, timing, table, and side effects.',
  },
  {
    key: 'gap.generated-columns',
    title: 'Generated columns need explicit raw-SQL provenance comments',
    guidance:
      'Generated column definitions should name the raw SQL migration and whether the column is VIRTUAL or STORED before consumers depend on it.',
  },
  {
    key: 'gap.expression-indexes',
    title: 'Expression and partial indexes need predicate/expression rationale',
    guidance:
      'Expression/partial indexes expressed through sql templates should explain query shape, predicate, and fallback raw SQL migration behavior.',
  },
] as const;

/** Return the matrix entry for a stable SQLite feature key. */
export function getSqliteFeatureExpressivenessEntry(
  key: string,
): SqliteFeatureExpressivenessEntry | undefined {
  return SQLITE_FEATURE_EXPRESSIVENESS_MATRIX.find((entry) => entry.key === key);
}
