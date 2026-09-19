/** Durable, resource-scoped recovery for Exodus INSERTs (T12260). */
import type { DatabaseSync, SQLInputValue } from 'node:sqlite';
import { z } from 'zod';

const RECEIPTS = '_exodus_recovery_rows';
const identitySchema = z.array(
  z.tuple([z.enum(['null', 'integer', 'real', 'text', 'blob']), z.string()]),
);

/** A copy whose effects cannot be recovered must abort the source transaction. */
export class ExodusRecoveryError extends Error {}

function identityValues(encoded: string): SQLInputValue[] {
  return identitySchema.parse(JSON.parse(encoded)).map(([kind, value]) => {
    if (kind === 'null') return null;
    if (kind === 'integer') return BigInt(value);
    if (kind === 'real')
      return value === '9.0e+999' ? Infinity : value === '-9.0e+999' ? -Infinity : Number(value);
    const bytes = Buffer.from(value, 'hex');
    return kind === 'text' ? bytes.toString('utf8') : bytes;
  });
}

function identifier(value: string): string {
  return `"${value.replaceAll('"', '""')}"`;
}

/** SQLite encodes every value without lossy JS numbers or NUL string truncation. */
function image(columns: readonly string[]): string {
  return `json_array(${columns
    .map((name) => {
      const col = identifier(name);
      return `json_array(typeof(${col}), CASE WHEN typeof(${col}) IN ('text','blob') THEN hex(${col}) ELSE quote(${col}) END)`;
    })
    .join(',')})`;
}

function tableShape(db: DatabaseSync, schema: string, table: string) {
  const sql = db
    .prepare(`SELECT sql FROM ${identifier(schema)}.sqlite_master WHERE type='table' AND name=?`)
    .get(table)?.sql;
  if (typeof sql !== 'string' || /CREATE\s+VIRTUAL\s+TABLE/i.test(sql)) {
    throw new ExodusRecoveryError(`Exodus recovery requires an ordinary table: ${schema}.${table}`);
  }
  const triggers = db
    .prepare(
      `SELECT name FROM ${identifier(schema)}.sqlite_master WHERE type='trigger' AND tbl_name=?`,
    )
    .all(table);
  const tempTriggers = db
    .prepare("SELECT name FROM temp.sqlite_master WHERE type='trigger' AND tbl_name=?")
    .all(table);
  if (triggers.length || tempTriggers.length) {
    throw new ExodusRecoveryError(
      `Exodus recovery cannot certify trigger side effects: ${schema}.${table}`,
    );
  }
  const columns = db
    .prepare(`PRAGMA ${identifier(schema)}.table_xinfo(${identifier(table)})`)
    .all();
  const names = columns.map((column) => {
    if (typeof column.name !== 'string')
      throw new ExodusRecoveryError('Invalid Exodus column metadata');
    return column.name;
  });
  const rowid = /\bWITHOUT\s+ROWID\b/i.test(sql)
    ? undefined
    : ['_rowid_', 'rowid', 'oid'].find((name) => !names.includes(name));
  const keys = rowid
    ? [rowid]
    : columns
        .filter((column) => Number(column.pk) > 0)
        .sort((a, b) => Number(a.pk) - Number(b.pk))
        .map((column) => String(column.name));
  if (!keys.length)
    throw new ExodusRecoveryError(
      `Exodus recovery needs a stable row identity: ${schema}.${table}`,
    );
  return { sql, keys, identity: image(keys), row: image(names) };
}

function ensureReceipts(db: DatabaseSync, schema: string): void {
  db.exec(`CREATE TABLE IF NOT EXISTS ${identifier(schema)}.${identifier(RECEIPTS)} (
    id INTEGER PRIMARY KEY,
    operation_id TEXT NOT NULL,
    target_db TEXT NOT NULL,
    target_table TEXT NOT NULL,
    source_db TEXT NOT NULL,
    source_table TEXT NOT NULL,
    table_sql TEXT NOT NULL,
    identity_json TEXT NOT NULL,
    row_json TEXT NOT NULL,
    state TEXT NOT NULL DEFAULT 'committed' CHECK(state IN ('committed','rolled_back'))
  )`);
}

/** Whether an existing staging journal has durable ownership on this target. */
export function hasExodusRecovery(db: DatabaseSync, operation: string): boolean {
  const present = db
    .prepare(
      "SELECT name FROM main.sqlite_master WHERE type='table' AND name='_exodus_recovery_operations'",
    )
    .get();
  if (!present) return false;
  const target = db
    .prepare('PRAGMA database_list')
    .all()
    .find((entry) => entry.name === 'main')?.file;
  return (
    db
      .prepare('SELECT target_db FROM main._exodus_recovery_operations WHERE operation_id=?')
      .get(operation)?.target_db === target
  );
}

/** Register the existing staging operation on the exact target before copy. */
export function prepareExodusRecovery(db: DatabaseSync, operation: string, schema = 'main'): void {
  ensureReceipts(db, schema);
  db.exec(`CREATE TABLE IF NOT EXISTS ${identifier(schema)}._exodus_recovery_operations (
    operation_id TEXT PRIMARY KEY, target_db TEXT NOT NULL
  )`);
  const target = db
    .prepare('PRAGMA database_list')
    .all()
    .find((entry) => entry.name === schema)?.file;
  if (typeof target !== 'string' || !target)
    throw new ExodusRecoveryError('Exodus recovery needs a durable target database');
  const prior = db
    .prepare(
      `SELECT target_db FROM ${identifier(schema)}._exodus_recovery_operations WHERE operation_id=?`,
    )
    .get(operation);
  if (prior && prior.target_db !== target)
    throw new ExodusRecoveryError('Exodus recovery operation target changed');
  db.prepare(
    `INSERT OR IGNORE INTO ${identifier(schema)}._exodus_recovery_operations VALUES (?,?)`,
  ).run(operation, target);
}

/**
 * Execute an INSERT with exact inserted-row receipts in the caller's existing
 * transaction. A savepoint rolls back both rows and receipts on any failure.
 * Ignored rows produce no receipts. Triggers/virtual tables are refused because
 * RETURNING cannot certify their side effects. The operation is the existing
 * Exodus staging-journal directory, not a separate repair engine.
 */
export function insertWithExodusReceipts(
  db: DatabaseSync,
  schema: string,
  table: string,
  insertSql: string,
  operation: string,
  sourceDb: string,
  sourceTable: string,
): number {
  if (!db.isTransaction)
    throw new ExodusRecoveryError('Exodus row receipts require the source transaction');
  const shape = tableShape(db, schema, table);
  const target = db
    .prepare('PRAGMA database_list')
    .all()
    .find((entry) => entry.name === schema)?.file;
  if (typeof target !== 'string' || !target)
    throw new ExodusRecoveryError('Exodus recovery needs a durable target database');
  db.exec('SAVEPOINT exodus_copy_receipts');
  try {
    prepareExodusRecovery(db, operation, schema);
    const record = db.prepare(`INSERT INTO ${identifier(schema)}.${identifier(RECEIPTS)}
      (operation_id,target_db,target_table,source_db,source_table,table_sql,identity_json,row_json)
      VALUES (?,?,?,?,?,?,?,?)`);
    let inserted = 0;
    for (const row of db
      .prepare(
        `${insertSql} RETURNING ${shape.identity} AS identity_json, ${shape.row} AS row_json`,
      )
      .iterate()) {
      if (typeof row.identity_json !== 'string' || typeof row.row_json !== 'string')
        throw new ExodusRecoveryError('Invalid Exodus returned row image');
      record.run(
        operation,
        target,
        table,
        sourceDb,
        sourceTable,
        shape.sql,
        row.identity_json,
        row.row_json,
      );
      inserted++;
    }
    db.exec('RELEASE exodus_copy_receipts');
    return inserted;
  } catch (error) {
    db.exec('ROLLBACK TO exodus_copy_receipts');
    db.exec('RELEASE exodus_copy_receipts');
    throw new ExodusRecoveryError(error instanceof Error ? error.message : String(error), {
      cause: error,
    });
  }
}

/**
 * Roll back only unchanged rows owned by this staging operation. Every affected
 * row is checked before any delete; mismatches reject the whole scope. Receipts
 * stay durable and change state in the same transaction as their guarded delete.
 * Unrelated tables, inserts and updates are outside the recovery resource set.
 */
export function rollbackExodusReceipts(db: DatabaseSync, operation: string): number {
  const present = db
    .prepare("SELECT name FROM main.sqlite_master WHERE type='table' AND name=?")
    .get(RECEIPTS);
  if (!present)
    throw new ExodusRecoveryError(
      'Exodus recovery receipts missing; automatic destructive recovery refused',
    );
  if (db.isTransaction)
    throw new ExodusRecoveryError('Exodus recovery requires a dedicated idle connection');
  const registered = db
    .prepare('SELECT target_db FROM main._exodus_recovery_operations WHERE operation_id=?')
    .get(operation);
  const actualTarget = db
    .prepare('PRAGMA database_list')
    .all()
    .find((entry) => entry.name === 'main')?.file;
  if (!registered || registered.target_db !== actualTarget)
    throw new ExodusRecoveryError('Exodus recovery operation is not registered on this target');
  const foreignKeys = Number(db.prepare('PRAGMA foreign_keys').get()?.foreign_keys ?? 0);
  db.exec('PRAGMA foreign_keys = OFF');
  db.exec('BEGIN IMMEDIATE');
  try {
    const rows = db
      .prepare(
        `SELECT * FROM main.${identifier(RECEIPTS)} WHERE operation_id=? AND state='committed' ORDER BY id DESC`,
      )
      .all(operation);
    const target = db
      .prepare('PRAGMA database_list')
      .all()
      .find((entry) => entry.name === 'main')?.file;
    const shapes = new Map<string, ReturnType<typeof tableShape>>();
    const beforeViolations = new Set(
      db
        .prepare('PRAGMA main.foreign_key_check')
        .all()
        .map((row) => JSON.stringify(row)),
    );
    const guarded = rows.map((receipt) => {
      if (
        receipt.target_db !== target ||
        typeof receipt.target_table !== 'string' ||
        typeof receipt.identity_json !== 'string' ||
        typeof receipt.row_json !== 'string'
      ) {
        throw new ExodusRecoveryError('Exodus recovery receipt target or row identity mismatch');
      }
      const shape =
        shapes.get(receipt.target_table) ?? tableShape(db, 'main', receipt.target_table);
      shapes.set(receipt.target_table, shape);
      if (shape.sql !== receipt.table_sql)
        throw new ExodusRecoveryError(`Exodus recovery schema changed: ${receipt.target_table}`);
      const values = identityValues(receipt.identity_json);
      if (values.length !== shape.keys.length)
        throw new ExodusRecoveryError('Exodus row identity shape changed');
      const predicate = `${shape.keys.map((key) => `${identifier(key)} IS ?`).join(' AND ')} AND ${shape.row}=?`;
      const count = db
        .prepare(
          `SELECT count(*) AS n FROM main.${identifier(receipt.target_table)} WHERE ${predicate}`,
        )
        .get(...values, receipt.row_json)?.n;
      if (count !== 1)
        throw new ExodusRecoveryError(
          `Exodus recovery row changed or missing: ${receipt.target_table} receipt ${String(receipt.id)}`,
        );
      return { receipt, predicate, values };
    });
    for (const { receipt, predicate, values } of guarded) {
      const deleted = db
        .prepare(`DELETE FROM main.${identifier(String(receipt.target_table))} WHERE ${predicate}`)
        .run(...values, receipt.row_json);
      if (Number(deleted.changes) !== 1)
        throw new ExodusRecoveryError('Exodus guarded delete did not remove exactly one row');
      db.prepare(`UPDATE main.${identifier(RECEIPTS)} SET state='rolled_back' WHERE id=?`).run(
        receipt.id,
      );
    }
    const introduced = db
      .prepare('PRAGMA main.foreign_key_check')
      .all()
      .filter((row) => !beforeViolations.has(JSON.stringify(row)));
    if (introduced.length)
      throw new ExodusRecoveryError('Exodus recovery would orphan unrelated rows');
    db.exec('COMMIT');
    return guarded.length;
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  } finally {
    db.exec(`PRAGMA foreign_keys = ${foreignKeys}`);
  }
}
