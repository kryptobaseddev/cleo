/** Durable, resource-scoped recovery for Exodus INSERTs (T12260). */
import { randomUUID } from 'node:crypto';
import { constants, type DatabaseSync, type SQLInputValue } from 'node:sqlite';
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
  const columns = db
    .prepare(`PRAGMA ${identifier(schema)}.table_xinfo(${identifier(table)})`)
    .all();
  const names = columns.map((column) => {
    if (typeof column.name !== 'string')
      throw new ExodusRecoveryError('Invalid Exodus column metadata');
    return column.name;
  });
  const keys = columns
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
    kind TEXT NOT NULL DEFAULT 'insert' CHECK(kind IN ('insert','handoff_update')),
    before_row_json TEXT,
    before_value TEXT,
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
 * Compile on the dedicated migration handle under SQLite's effect authorizer.
 * Guard triggers are read-only. The only supported extra mutation is the
 * canonical session handoff mirror, whose complete changed-row set is captured
 * below. Extension/UDF functions are refused because their effects are opaque.
 * These dedicated handles are created by Exodus without an existing authorizer;
 * the temporary policy is always removed before receipt statements execute.
 */
function inspectEffects(
  db: DatabaseSync,
  sql: string,
  schema: string,
  table: string,
  action: number,
): boolean {
  const functions = db.prepare('PRAGMA function_list').all();
  // SQLite retains built-in overloads after an application replaces a name.
  // Refuse the entire overridden name; its runtime dispatch is opaque here.
  const overridden = new Set(functions.filter((row) => row.builtin !== 1).map((row) => row.name));
  const builtins = new Set(
    functions
      .filter((row) => row.builtin === 1 && !overridden.has(row.name))
      .map((row) => row.name),
  );
  let mirrorsHandoff = false;
  let refusal: string | undefined;
  db.setAuthorizer((code, name, column, dbName, trigger) => {
    if (
      code === constants.SQLITE_FUNCTION &&
      (!builtins.has(column) || column === 'load_extension')
    ) {
      refusal = `opaque function ${String(column)}`;
      return constants.SQLITE_DENY;
    }
    if (
      [constants.SQLITE_INSERT, constants.SQLITE_UPDATE, constants.SQLITE_DELETE].includes(code)
    ) {
      if (!trigger && code === action && dbName === schema && name === table)
        return constants.SQLITE_OK;
      if (
        trigger &&
        action === constants.SQLITE_INSERT &&
        code === constants.SQLITE_UPDATE &&
        dbName === schema &&
        name === 'tasks_sessions' &&
        column === 'handoff_json'
      ) {
        mirrorsHandoff = true;
        return constants.SQLITE_OK;
      }
      refusal = `untracked trigger side effects: ${String(dbName)}.${String(name)} ${String(column)}`;
      return constants.SQLITE_DENY;
    }
    return constants.SQLITE_OK;
  });
  try {
    db.prepare(sql);
  } catch (error) {
    throw new ExodusRecoveryError(
      refusal ?? (error instanceof Error ? error.message : String(error)),
      { cause: error },
    );
  } finally {
    db.setAuthorizer(null);
  }
  return mirrorsHandoff;
}

function handoffSnapshot(db: DatabaseSync, schema: string) {
  const shape = tableShape(db, schema, 'tasks_sessions');
  const rows = db
    .prepare(
      `SELECT ${shape.identity} AS identity_json,${shape.row} AS row_json,${image(['handoff_json'])} AS handoff_value FROM ${identifier(schema)}.tasks_sessions`,
    )
    .all();
  return {
    shape,
    rows: new Map(
      rows.map((row) => {
        if (
          typeof row.identity_json !== 'string' ||
          typeof row.row_json !== 'string' ||
          typeof row.handoff_value !== 'string'
        )
          throw new ExodusRecoveryError('Invalid handoff row image');
        if (identityValues(row.identity_json).includes(null))
          throw new ExodusRecoveryError('Exodus recovery cannot own a nullable primary key');
        return [row.identity_json, { row: row.row_json, value: row.handoff_value }];
      }),
    ),
  };
}

/**
 * Execute an INSERT with exact inserted-row receipts in the caller's existing
 * transaction. A savepoint rolls back both rows and receipts on any failure.
 * Ignored rows produce no receipts. SQLite authorizes read-only guards; handoff
 * mirror changes receive before/after receipts. Other write effects are refused. The operation is the existing
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
    const statement = `${insertSql} RETURNING ${shape.identity} AS identity_json, ${shape.row} AS row_json`;
    const mirrorsHandoff = inspectEffects(db, statement, schema, table, constants.SQLITE_INSERT);
    const before = mirrorsHandoff ? handoffSnapshot(db, schema) : undefined;
    let inserted = 0;
    for (const row of db.prepare(statement).iterate()) {
      if (typeof row.identity_json !== 'string' || typeof row.row_json !== 'string')
        throw new ExodusRecoveryError('Invalid Exodus returned row image');
      if (identityValues(row.identity_json).includes(null))
        throw new ExodusRecoveryError('Exodus recovery cannot own a nullable primary key');
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
    if (before) {
      const after = handoffSnapshot(db, schema);
      for (const [identity, current] of after.rows) {
        const previous = before.rows.get(identity);
        if (!previous)
          throw new ExodusRecoveryError('Handoff mirror unexpectedly inserted a session');
        if (previous.row === current.row) continue;
        db.prepare(`INSERT INTO ${identifier(schema)}.${identifier(RECEIPTS)}
          (operation_id,target_db,target_table,source_db,source_table,table_sql,identity_json,row_json,kind,before_row_json,before_value)
          VALUES (?,?,?,?,?,?,?,?,?,?,?)`).run(
          operation,
          target,
          'tasks_sessions',
          sourceDb,
          sourceTable,
          before.shape.sql,
          identity,
          current.row,
          'handoff_update',
          previous.row,
          previous.value,
        );
      }
      if (after.rows.size !== before.rows.size)
        throw new ExodusRecoveryError('Handoff mirror unexpectedly removed a session');
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
    const simulated = new Map<string, string | null>();
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
      const key = JSON.stringify([receipt.target_table, receipt.identity_json]);
      if (!simulated.has(key)) {
        const actual = db
          .prepare(
            `SELECT ${shape.row} AS row_json FROM main.${identifier(receipt.target_table)} WHERE ${shape.keys.map((name) => `${identifier(name)} IS ?`).join(' AND ')}`,
          )
          .all(...values);
        if (actual.length !== 1 || typeof actual[0]?.row_json !== 'string')
          throw new ExodusRecoveryError(
            `Exodus recovery row changed or missing: ${receipt.target_table}`,
          );
        simulated.set(key, actual[0].row_json);
      }
      if (simulated.get(key) !== receipt.row_json)
        throw new ExodusRecoveryError(
          `Exodus recovery row changed or missing: ${receipt.target_table} receipt ${String(receipt.id)}`,
        );
      if (receipt.kind === 'handoff_update') {
        if (
          receipt.target_table !== 'tasks_sessions' ||
          typeof receipt.before_row_json !== 'string' ||
          typeof receipt.before_value !== 'string'
        )
          throw new ExodusRecoveryError('Invalid handoff recovery receipt');
        simulated.set(key, receipt.before_row_json);
      } else if (receipt.kind === 'insert') simulated.set(key, null);
      else throw new ExodusRecoveryError('Unsupported Exodus recovery effect');
      return { receipt, predicate, values };
    });
    for (const { receipt, predicate, values } of guarded) {
      const sql =
        receipt.kind === 'handoff_update'
          ? `UPDATE main.tasks_sessions SET handoff_json=? WHERE ${predicate}`
          : `DELETE FROM main.${identifier(String(receipt.target_table))} WHERE ${predicate}`;
      inspectEffects(
        db,
        sql,
        'main',
        String(receipt.target_table),
        receipt.kind === 'handoff_update' ? constants.SQLITE_UPDATE : constants.SQLITE_DELETE,
      );
      const before =
        receipt.kind === 'handoff_update' ? identityValues(String(receipt.before_value)) : [];
      const changed = db.prepare(sql).run(...before, ...values, receipt.row_json);
      if (Number(changed.changes) !== 1)
        throw new ExodusRecoveryError('Exodus guarded recovery did not affect exactly one row');
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

/** Commit a fresh cutover token to this exact database generation before its marker. */
export function sealExodusDatabase(db: DatabaseSync): string {
  if (db.isTransaction)
    throw new ExodusRecoveryError('Exodus sealing requires a dedicated idle handle');
  const token = randomUUID();
  db.exec('BEGIN IMMEDIATE');
  try {
    db.exec(
      'CREATE TABLE IF NOT EXISTS main._exodus_database_identity(id INTEGER PRIMARY KEY CHECK(id=1),token TEXT NOT NULL)',
    );
    db.prepare(
      'INSERT INTO main._exodus_database_identity VALUES(1,?) ON CONFLICT(id) DO UPDATE SET token=excluded.token',
    ).run(token);
    db.exec('COMMIT');
    return token;
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
}

/** Verify a marker's cutover token against the existing caller's database handle. */
export function hasExodusDatabaseIdentity(db: DatabaseSync, token: string): boolean {
  const present = db
    .prepare(
      "SELECT name FROM main.sqlite_master WHERE type='table' AND name='_exodus_database_identity'",
    )
    .get();
  return Boolean(
    present &&
      db.prepare('SELECT token FROM main._exodus_database_identity WHERE id=1').get()?.token ===
        token,
  );
}
