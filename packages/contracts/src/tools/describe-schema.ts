/**
 * Contract types for the describeSchema SDK tool.
 *
 * @arch SDK Tool (Category B) — harness-agnostic, pure-functional
 * @task T10071
 * @epic T9835
 */

/** A single column in a table descriptor. */
export interface SchemaColumn {
  /** Column name as declared in the drizzle schema. */
  name: string;
  /** SQLite data type (e.g. "TEXT", "INTEGER", "REAL", "BLOB"). */
  type: string;
  /** True when the column has a NOT NULL constraint. */
  notNull: boolean;
  /** True when the column is part of the primary key. */
  primaryKey: boolean;
}

/** A single index in a table descriptor. */
export interface SchemaIndex {
  /** Index name as declared in the drizzle schema. */
  name: string;
  /** True when the index enforces uniqueness. */
  unique: boolean;
}

/** Descriptor for one database table. */
export interface SchemaTableDescriptor {
  /** Table name as stored in SQLite (snake_case). */
  name: string;
  /** Ordered list of column descriptors. */
  columns: SchemaColumn[];
  /** List of indexes defined on this table (may be empty). */
  indexes: SchemaIndex[];
}

/** Full output of describeSchema — all tables in the drizzle schema. */
export interface SchemaDescriptor {
  /** One entry per drizzle table exported from the schema barrel. */
  tables: SchemaTableDescriptor[];
}
