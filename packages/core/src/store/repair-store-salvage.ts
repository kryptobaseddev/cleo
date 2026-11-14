/** Copy-only SQLite salvage. No handle in this module ever opens the live store. */
import { spawnSync } from 'node:child_process';
import { closeSync, existsSync, openSync, readSync, realpathSync, statSync } from 'node:fs';
import { basename } from 'node:path';
import type { DatabaseSync, SQLOutputValue, StatementSync } from 'node:sqlite';
import type {
  StoreRepairReceipt,
  StoreRepairRecoveryRow,
} from '@cleocode/contracts/db-recovery.js';
import { openCleoDbSnapshot } from './open-cleo-db.js';
import { repairSalvageHeader } from './repair-store-files.js';
import { ensureTriggerSuspendTable, withTriggersSuspended } from './sync/trigger-classes.js';

type Row = Record<string, SQLOutputValue>;
interface Table {
  name: string;
  sql: string;
  root: number;
}
interface Column {
  name: string;
  pk: number;
}

const ROWID = '__cleo_repair_rowid';

/** Quote an identifier obtained from a private database's schema. */
export function repairIdentifier(name: string): string {
  return `"${name.replaceAll('"', '""')}"`;
}

/** Enumerate even a partially readable schema, preserving rows yielded before an error. */
function tables(db: DatabaseSync, diagnostics: string[], file: string): Table[] {
  const found: Table[] = [];
  try {
    db.exec('PRAGMA writable_schema=ON');
    const complete = readRows(db, file, { name: 'sqlite_schema', root: 1, sql: '' }, (row) => {
      if (row.type === 'table' && typeof row.name === 'string' && typeof row.sql === 'string') {
        found.push({ name: row.name, sql: row.sql, root: Number(row.rootpage) });
      }
    });
    if (!complete)
      diagnostics.push('sqlite_schema: unreadable ranges; schema coverage is incomplete');
  } catch (error) {
    diagnostics.push(`schema: ${error instanceof Error ? error.message : String(error)}`);
  }
  return found;
}

function columns(db: DatabaseSync, table: string): Column[] {
  return db
    .prepare(`PRAGMA main.table_xinfo(${repairIdentifier(table)})`)
    .all()
    .filter((r) => r.hidden === 0 || r.hidden === 0n)
    .map((r) => ({ name: String(r.name), pk: Number(r.pk) }));
}

function timestamp(value: SQLOutputValue | undefined): number {
  if (typeof value === 'number' || typeof value === 'bigint') {
    const n = Number(value);
    return Number.isFinite(n)
      ? Math.abs(n) < 100_000_000_000
        ? n * 1000
        : n
      : Number.NEGATIVE_INFINITY;
  }
  if (typeof value !== 'string') return Number.NEGATIVE_INFINITY;
  if (/^\d+(?:\.\d+)?$/.test(value)) return timestamp(Number(value));
  const iso = value.replace(/^(\d{4}-\d\d-\d\d) /, '$1T');
  const parsed = Date.parse(
    /^\d{4}-\d\d-\d\dT/.test(iso) && !/(?:Z|[+-]\d\d:\d\d)$/i.test(iso) ? `${iso}Z` : iso,
  );
  return Number.isNaN(parsed) ? Number.NEGATIVE_INFINITY : parsed;
}

/** SQLite varint, including signed rowids represented as unsigned 64-bit integers. */
function varint(page: Buffer, start: number): { value: bigint; end: number } | null {
  let value = 0n;
  for (let i = 0; i < 9 && start + i < page.length; i++) {
    const b = page[start + i];
    if (b === undefined) return null;
    value = (value << BigInt(i === 8 ? 8 : 7)) | BigInt(i === 8 ? b : b & 127);
    if (i === 8 || b < 128) return { value, end: start + i + 1 };
  }
  return null;
}

/**
 * Visit rowid leaf ranges directly from the b-tree. A zeroed leaf does not
 * prevent seeking into its later siblings, unlike resuming a failed cursor.
 * The private WAL view is checkpointed first, so page addresses match SQLite.
 */
function leafRanges(
  file: string,
  root: number,
  visit: (lo: bigint, hi: bigint, ids: bigint[]) => void,
): void {
  const fd = openSync(file, 'r');
  try {
    const header = Buffer.alloc(100);
    readSync(fd, header, 0, 100, 0);
    const rawSize = header.readUInt16BE(16);
    const size = rawSize === 1 ? 65536 : rawSize;
    if (size < 512 || size > 65536 || (size & (size - 1)) !== 0)
      // @sync-invariant none:local-only local recovery refuses before publishing a staged store image
      throw new Error('Unreadable SQLite page size');
    const pages = Math.floor(statSync(file).size / size);
    const seen = new Set<number>();
    const walk = (pageNo: number, lo: bigint, hi: bigint): void => {
      if (pageNo < 1 || pageNo > pages || seen.has(pageNo)) {
        visit(lo, hi, []);
        return;
      }
      seen.add(pageNo);
      const page = Buffer.alloc(size);
      readSync(fd, page, 0, size, (pageNo - 1) * size);
      const h = pageNo === 1 ? 100 : 0;
      const kind = page[h];
      if (kind !== 5 && kind !== 13) {
        visit(lo, hi, []);
        return;
      }
      const n = page.readUInt16BE(h + 3);
      const start = h + (kind === 5 ? 12 : 8);
      if (start + n * 2 > page.length) {
        visit(lo, hi, []);
        return;
      }
      let lower = lo;
      const ids: bigint[] = [];
      for (let i = 0; i < n; i++) {
        const cell = page.readUInt16BE(start + i * 2);
        if (cell < start || cell >= page.length) continue;
        if (kind === 5) {
          if (cell + 4 >= page.length) continue;
          const key = varint(page, cell + 4);
          if (!key) continue;
          const upper = BigInt.asIntN(64, key.value);
          if (upper < lower || upper > hi) continue;
          walk(page.readUInt32BE(cell), lower, upper);
          lower = upper + 1n;
        } else {
          const payload = varint(page, cell);
          const key = payload && varint(page, payload.end);
          if (key) ids.push(BigInt.asIntN(64, key.value));
        }
      }
      if (kind === 5) walk(page.readUInt32BE(h + 8), lower, hi);
      else visit(lo, hi, ids);
    };
    walk(root, -(1n << 63n), (1n << 63n) - 1n);
  } finally {
    closeSync(fd);
  }
}

function hasRowid(sql: string): boolean {
  return (
    !/\bWITHOUT\s+ROWID\b/i.test(sql) &&
    (!/\bVIRTUAL\s+TABLE\b/i.test(sql) || /\bUSING\s+fts[345]\b/i.test(sql))
  );
}

/** Stream readable rows; isolate bad pages without scanning an unbounded integer keyspace. */
function readRows(
  db: DatabaseSync,
  file: string,
  table: Table,
  accept: (row: Row) => void,
): boolean {
  const q = repairIdentifier(table.name);
  const rowid = hasRowid(table.sql);
  const select = `SELECT ${rowid ? `_rowid_ AS ${repairIdentifier(ROWID)}, ` : ''}* FROM main.${q} NOT INDEXED`;
  let iterator: ReturnType<StatementSync['iterate']> | undefined;
  try {
    const stmt = db.prepare(select);
    stmt.setReadBigInts(true);
    iterator = stmt.iterate();
  } catch (error) {
    if (
      !(error instanceof Error) ||
      !/malformed|corrupt|no such|not a database/i.test(error.message)
    )
      throw error;
  }
  while (iterator) {
    let next: IteratorResult<Row>;
    try {
      next = iterator.next();
    } catch {
      break;
    }
    if (next.done) return true;
    // A merge rejection is not a read failure and must never be skipped.
    accept(next.value);
  }
  if (!rowid || table.root < 1) return false;
  let complete = true;
  leafRanges(file, table.root, (lo, hi, ids) => {
    if (ids.length === 0) complete = false;
    let rows: Row[];
    try {
      const stmt = db.prepare(`${select} WHERE _rowid_ BETWEEN ? AND ?`);
      stmt.setReadBigInts(true);
      rows = stmt.all(lo, hi);
    } catch {
      complete = false;
      for (const id of ids) {
        let row: Row | undefined;
        try {
          const stmt = db.prepare(`${select} WHERE _rowid_ = ?`);
          stmt.setReadBigInts(true);
          row = stmt.get(id);
        } catch {
          continue;
        }
        if (row) accept(row);
      }
      return;
    }
    for (const row of rows) accept(row);
  });
  return complete;
}

/** Run the optional SQLite recovery extension into a separate, disposable database. */
function sqliteRecover(file: string, diagnostics: string[]): string | null {
  const sqlFile = `${file}.recover.sql`;
  const fd = openSync(sqlFile, 'wx');
  let recovered: ReturnType<typeof spawnSync>;
  try {
    recovered = spawnSync('sqlite3', ['-safe', file, '.recover --ignore-freelist'], {
      stdio: ['ignore', fd, 'pipe'],
      timeout: 60_000,
    });
  } finally {
    closeSync(fd);
  }
  if (recovered.error || recovered.status !== 0) {
    diagnostics.push(
      `sqlite3 .recover: ${recovered.error?.message ?? recovered.stderr?.toString().trim() ?? recovered.status}`,
    );
    return null;
  }
  const recoveredFile = `${file}.recovered`;
  const input = openSync(sqlFile, 'r');
  try {
    const applied = spawnSync('sqlite3', ['-safe', recoveredFile], {
      stdio: [input, 'ignore', 'pipe'],
      timeout: 60_000,
    });
    if (applied.error || applied.status !== 0) {
      diagnostics.push(
        `sqlite3 recovered SQL: ${applied.error?.message ?? applied.stderr?.toString().trim()}`,
      );
    }
  } finally {
    closeSync(input);
  }
  return existsSync(recoveredFile) && statSync(recoveredFile).size > 0 ? recoveredFile : null;
}

/** Count all physical tables, including journal and FTS shadow tables. */
export function repairTableCounts(db: DatabaseSync): Record<string, number> {
  const counts: Record<string, number> = {};
  Object.setPrototypeOf(counts, null);
  for (const row of db.prepare("SELECT name FROM main.sqlite_schema WHERE type='table'").all()) {
    const table = String(row.name);
    counts[table] = Number(
      db.prepare(`SELECT count(*) AS n FROM main.${repairIdentifier(table)}`).get()?.n,
    );
  }
  return counts;
}

/** Preserve a readable value without JSON's bigint and binary conversion losses. */
function recordRecovery(
  receipt: StoreRepairReceipt,
  kind: StoreRepairRecoveryRow['kind'],
  table: string,
  reason: string,
  row: Row,
  source?: string,
): void {
  receipt.recovery ??= { file: null, rows: [] };
  const values: StoreRepairRecoveryRow['values'] = {};
  Object.setPrototypeOf(values, null);
  for (const [name, value] of Object.entries(row)) {
    values[name] =
      typeof value === 'bigint'
        ? { type: 'bigint', value: value.toString() }
        : value instanceof Uint8Array
          ? { type: 'blob', value: Buffer.from(value).toString('base64') }
          : value;
  }
  receipt.recovery.rows.push({ kind, table, reason, values, ...(source ? { source } : {}) });
}

function rowKey(row: Row, identity: readonly string[]): string {
  return JSON.stringify(
    identity.map((name) => row[name] ?? null),
    (_key, value) => (typeof value === 'bigint' ? value.toString() : value),
  );
}

/** SQLite identifies FTS shadow tables; vec0 also has module-owned bookkeeping tables. */
function shadowTables(db: DatabaseSync, schema: readonly Table[]): Set<string> {
  const shadows = new Set<string>();
  try {
    for (const row of db.prepare('PRAGMA main.table_list').all())
      if (row.type === 'shadow') shadows.add(String(row.name));
  } catch {
    /* A partial schema is still salvaged below. */
  }
  for (const table of schema.filter((t) => /\bUSING\s+vec0\b/i.test(t.sql))) {
    for (const child of schema) {
      if (
        child.name.startsWith(`${table.name}_`) &&
        /^(?:info|chunks|rowids|vector_chunks\d+|metadatachunks\d+|metadatatext\d+)$/i.test(
          child.name.slice(table.name.length + 1),
        )
      )
        shadows.add(child.name);
    }
  }
  return shadows;
}

/** Recreate virtual storage from logical content; never copy module-owned shadow pages. */
function rebuildVirtual(db: DatabaseSync, table: Table): void {
  const name = repairIdentifier(table.name);
  if (contentlessFts(table)) {
    db.exec(`INSERT INTO main.${name} (${name}) VALUES ('delete-all')`);
    return;
  }
  const externalFts = /\bUSING\s+fts[345]\b/i.test(table.sql) && /\bcontent\s*=/i.test(table.sql);
  if (externalFts) {
    db.exec(`DROP TABLE main.${name}`);
    db.prepare(table.sql).run();
    return;
  }
  const names = columns(db, table.name).map((c) => c.name);
  if (hasRowid(table.sql)) names.unshift('rowid');
  const cols = names.map(repairIdentifier).join(',');
  // TEMP holds logical vectors/documents while their module rebuilds its own shadow tables.
  db.exec(`CREATE TEMP TABLE cleo_repair_virtual AS SELECT ${cols} FROM main.${name}`);
  db.exec(`DROP TABLE main.${name}`);
  db.prepare(table.sql).run();
  db.exec(`INSERT INTO main.${name} (${cols}) SELECT ${cols} FROM temp.cleo_repair_virtual`);
  db.exec('DROP TABLE temp.cleo_repair_virtual');
}

/** Contentless FTS5 stores no text to rebuild; its owning indexer supplies the source. */
function contentlessFts(table: Table): boolean {
  return /\bUSING\s+fts5\b/i.test(table.sql) && /\bcontent\s*=\s*(?:''|"")/i.test(table.sql);
}

/** Locate an FK offender even in a composite-key WITHOUT ROWID table. */
function orphanRows(db: DatabaseSync, violation: Row): Row[] {
  const q = repairIdentifier(String(violation.table));
  if (violation.rowid !== null) {
    const stmt = db.prepare(
      `SELECT _rowid_ AS ${repairIdentifier(ROWID)}, * FROM main.${q} WHERE _rowid_=?`,
    );
    stmt.setReadBigInts(true);
    return stmt.all(violation.rowid ?? null);
  }
  const parent = String(violation.parent);
  const pk = columns(db, parent)
    .filter((c) => c.pk > 0)
    .sort((a, b) => a.pk - b.pk);
  const foreign = db
    .prepare(`PRAGMA main.foreign_key_list(${q})`)
    .all()
    .filter((r) => Number(r.id) === Number(violation.fkid))
    .sort((a, b) => Number(a.seq) - Number(b.seq));
  const nonNull = foreign
    .map((r) => `c.${repairIdentifier(String(r.from))} IS NOT NULL`)
    .join(' AND ');
  const join = foreign
    .map(
      (r, i) =>
        `p.${repairIdentifier(String(r.to ?? pk[i]?.name))} = c.${repairIdentifier(String(r.from))}`,
    )
    .join(' AND ');
  const stmt = db.prepare(
    `SELECT c.* FROM main.${q} AS c WHERE ${nonNull} AND NOT EXISTS (SELECT 1 FROM main.${repairIdentifier(parent)} AS p WHERE ${join})`,
  );
  stmt.setReadBigInts(true);
  return stmt.all();
}

/**
 * Merge readable content from private damaged views, preserving incompatible rows separately.
 * The first view is authoritative only for complete reads without newer or divergent history. Later views fill gaps;
 * timestamps can establish a newer value, but never turn an older main-only view authoritative.
 * All writes target the staged snapshot (gate 28), under trigger suspension (gate 36).
 */
export function salvageIntoSnapshot(
  staged: string,
  views: readonly string[],
  receipt: StoreRepairReceipt,
): () => void {
  if (basename(realpathSync(staged)) === 'cleo.db')
    // @sync-invariant none:local-only local recovery refuses before publishing a staged store image
    throw new Error(
      'Salvage writes require a staged snapshot, never a canonical store or quarantine original',
    );
  Object.setPrototypeOf(receipt.tables, null);
  const preserveHistory =
    receipt.freshness?.some((f) => f.kind === 'snapshot' || f.divergent) === true;
  const journal: Row[] = [];
  const journalKeys = new Set<string>();
  const target = openCleoDbSnapshot(staged, {
    readOnly: false,
    applyPragmas: false,
    loadSqliteVec: true,
  });
  try {
    const db = target.db;
    db.exec('PRAGMA foreign_keys=OFF');
    ensureTriggerSuspendTable(db);
    const originalTriggers = db
      .prepare("SELECT name, sql FROM main.sqlite_schema WHERE type='trigger'")
      .all();
    const initialSchema = tables(db, receipt.diagnostics, staged);
    const targetTables = new Set(initialSchema.map((t) => t.name));
    const targetShadows = shadowTables(db, initialSchema);
    const virtual = new Map(
      initialSchema.filter((t) => /\bVIRTUAL\s+TABLE\b/i.test(t.sql)).map((t) => [t.name, t]),
    );
    const keys = new Map<string, Set<string>>();
    const authority = new Map<string, Set<string>>();
    const newestKeys = new Map<string, Set<string>>();
    const baseKeys = new Map<string, Set<string>>();
    const pending: (() => void)[] = [];
    const deletedKeys = new Map<string, Set<string>>();
    const alternateVersions = new Set<string>();
    const reportFor = (name: string) => {
      receipt.tables[name] ??= { snapshot: 0, salvaged: 0, merged: 0, unreadable: 0, final: 0 };
      return receipt.tables[name];
    };
    const removeBase = (table: string, row: Row, identity: readonly string[]): void => {
      if (baseKeys.get(table)?.delete(rowKey(row, identity))) {
        const report = reportFor(table);
        report.baseRemoved = (report.baseRemoved ?? 0) + 1;
      }
    };
    const recordDeleted = (
      table: string,
      row: Row,
      identity: readonly string[],
      reason: string,
    ): void => {
      const deleted = deletedKeys.get(table) ?? new Set<string>();
      deletedKeys.set(table, deleted);
      const key = rowKey(row, identity);
      if (deleted.has(key)) return;
      deleted.add(key);
      reportFor(table).deleted = deleted.size;
      recordRecovery(receipt, 'deleted', table, reason, row);
    };
    db.exec('BEGIN IMMEDIATE');
    try {
      withTriggersSuspended(db, ['all'], 'rewind', () => {
        for (const trigger of originalTriggers)
          db.exec(`DROP TRIGGER ${repairIdentifier(String(trigger.name))}`);
        for (const table of virtual.values()) rebuildVirtual(db, table);
        for (const name of targetShadows) reportFor(name).rebuilt = true;
        for (const table of initialSchema) {
          if (
            targetShadows.has(table.name) ||
            ['cleo_trigger_suspend', 'sqlite_sequence', '__drizzle_migrations'].includes(table.name)
          )
            continue;
          if (/\bUSING\s+fts[345]\b/i.test(table.sql) && /\bcontent\s*=/i.test(table.sql)) {
            reportFor(table.name).rebuilt = true;
            continue;
          }
          const cols = columns(db, table.name);
          let identity = cols
            .filter((c) => c.pk > 0)
            .sort((a, b) => a.pk - b.pk)
            .map((c) => c.name);
          if (identity.length === 0)
            identity = hasRowid(table.sql) ? [ROWID] : cols.map((c) => c.name);
          const base = new Set<string>();
          readRows(db, staged, table, (row) => base.add(rowKey(row, identity)));
          baseKeys.set(table.name, base);
        }
        for (const view of views) {
          try {
            const cp = openCleoDbSnapshot(view, {
              readOnly: false,
              applyPragmas: false,
              loadSqliteVec: true,
            });
            try {
              cp.db.exec('PRAGMA writable_schema=ON; PRAGMA wal_checkpoint(TRUNCATE)');
            } finally {
              cp.close();
            }
          } catch (error) {
            receipt.diagnostics.push(
              `checkpoint ${view}: ${error instanceof Error ? error.message : String(error)}`,
            );
          }
          const recovered = sqliteRecover(view, receipt.diagnostics);
          const headerRecovered = repairSalvageHeader(view, staged);
          if (headerRecovered)
            receipt.diagnostics.push(
              `Reconstructed a disposable header for ${view}; original remains quarantined`,
            );
          for (const source of [view, recovered, headerRecovered].filter(
            (path): path is string => path !== null,
          )) {
            let snap: ReturnType<typeof openCleoDbSnapshot>;
            try {
              snap = openCleoDbSnapshot(source, { applyPragmas: false, loadSqliteVec: true });
            } catch (error) {
              for (const report of Object.values(receipt.tables)) report.unreadable = null;
              receipt.diagnostics.push(
                `open ${source}: ${error instanceof Error ? error.message : String(error)}`,
              );
              continue;
            }
            try {
              const beforeSchema = receipt.diagnostics.length;
              const sourceTables = tables(snap.db, receipt.diagnostics, source);
              const incompleteSchema = receipt.diagnostics.length !== beforeSchema;
              if (incompleteSchema)
                for (const report of Object.values(receipt.tables)) report.unreadable = null;
              const shadows = shadowTables(snap.db, sourceTables);
              for (const table of sourceTables) {
                const report = reportFor(table.name);
                if (shadows.has(table.name)) {
                  report.rebuilt = true;
                  continue;
                }
                if (table.name === 'cleo_trigger_suspend' || table.name === 'sqlite_sequence')
                  continue;
                const externalFts =
                  /\bUSING\s+fts[345]\b/i.test(table.sql) && /\bcontent\s*=/i.test(table.sql);
                if (!targetTables.has(table.name)) {
                  try {
                    if (!/^\s*CREATE\s+(?:VIRTUAL\s+)?TABLE\b/i.test(table.sql))
                      // @sync-invariant none:input-shape a recovered schema row must declare a table
                      throw new Error(`Invalid recovered table definition: ${table.name}`);
                    const ddl = db.prepare(table.sql);
                    ddl.setReadBigInts(true);
                    ddl.run();
                    targetTables.add(table.name);
                    if (/\bVIRTUAL\s+TABLE\b/i.test(table.sql)) virtual.set(table.name, table);
                  } catch (error) {
                    receipt.diagnostics.push(
                      `${table.name}: cannot recreate schema: ${error instanceof Error ? error.message : String(error)}`,
                    );
                    const complete = readRows(snap.db, source, table, (row) => {
                      report.salvaged++;
                      report.conflicts = (report.conflicts ?? 0) + 1;
                      recordRecovery(
                        receipt,
                        'conflict',
                        table.name,
                        `schema: ${error instanceof Error ? error.message : String(error)}`,
                        row,
                      );
                    });
                    if (!complete) report.unreadable = null;
                    continue;
                  }
                }
                if (externalFts) {
                  report.rebuilt = true;
                  continue;
                }
                if (table.name === '__drizzle_migrations') {
                  const complete = readRows(snap.db, source, table, (row) => {
                    const key = String(row.id ?? row[ROWID]);
                    if (!journalKeys.has(key)) {
                      journalKeys.add(key);
                      journal.push(row);
                      report.salvaged++;
                    }
                  });
                  if (!complete) {
                    report.unreadable = null;
                    receipt.diagnostics.push(
                      `${table.name}: unreadable migration-journal ranges; their row count is unknown`,
                    );
                  }
                  continue;
                }
                const destColumns = columns(db, table.name);
                const incoming = columns(snap.db, table.name).map((c) => c.name);
                const common = destColumns
                  .filter((c) => incoming.includes(c.name))
                  .map((c) => c.name);
                const missing = incoming.filter((c) => !common.includes(c));
                let pk = destColumns
                  .filter((c) => c.pk > 0)
                  .sort((a, b) => a.pk - b.pk)
                  .map((c) => c.name);
                if (pk.length === 0 && hasRowid(table.sql)) {
                  pk = [ROWID];
                  common.unshift(ROWID);
                }
                const identity = pk.length > 0 ? pk : common;
                const col = (c: string): string => repairIdentifier(c === ROWID ? '_rowid_' : c);
                const q = `main.${repairIdentifier(table.name)}`;
                // FTS5 indexes rowid equality, but IS scans the entire virtual table for every row.
                const where = identity
                  .map((c) => `${col(c)} ${c === ROWID ? '=' : 'IS'} ?`)
                  .join(' AND ');
                const find = db.prepare(`SELECT * FROM ${q} WHERE ${where} LIMIT 1`);
                find.setReadBigInts(true);
                const ins = db.prepare(
                  `INSERT INTO ${q} (${common.map(col).join(',')}) VALUES (${common.map(() => '?').join(',')})`,
                );
                ins.setReadBigInts(true);
                const stamp = ['updated_at', 'updatedAt', 'modified_at', 'modifiedAt'].find((c) =>
                  common.includes(c),
                );
                const updates = common.filter((c) => !pk.includes(c));
                const update =
                  updates.length > 0
                    ? db.prepare(
                        `UPDATE ${q} SET ${updates.map((c) => `${col(c)}=?`).join(',')} WHERE ${where}`,
                      )
                    : null;
                update?.setReadBigInts(true);
                const seen = keys.get(table.name) ?? new Set<string>();
                keys.set(table.name, seen);
                if (!baseKeys.has(table.name)) {
                  const base = new Set<string>();
                  readRows(db, staged, table, (row) => base.add(rowKey(row, identity)));
                  baseKeys.set(table.name, base);
                }
                const thisRead = new Set<string>();
                const apply = (row: Row, first: boolean): void => {
                  const values = identity.map((c) => row[c] ?? null);
                  const old = find.get(...values);
                  if (!old) {
                    ins.run(...common.map((c) => row[c] ?? null));
                    report.merged++;
                    return;
                  }
                  const incomingAt = stamp ? timestamp(row[stamp]) : Number.NEGATIVE_INFINITY;
                  const oldAt = stamp ? timestamp(old[stamp]) : Number.NEGATIVE_INFINITY;
                  const provenOlder =
                    Number.isFinite(incomingAt) && Number.isFinite(oldAt) && oldAt > incomingAt;
                  const provenNewer =
                    Number.isFinite(incomingAt) && Number.isFinite(oldAt) && incomingAt > oldAt;
                  if (!update || provenOlder) return;
                  const different = updates.some((c) => {
                    const a = row[c] ?? null,
                      b = old[c] ?? null;
                    return a instanceof Uint8Array && b instanceof Uint8Array
                      ? !Buffer.from(a).equals(b)
                      : a !== b;
                  });
                  if (!different) return;
                  if (!provenNewer && (preserveHistory || !first || view !== views[0])) {
                    const version = `${table.name}\0${view}\0${rowKey(row, identity)}`;
                    if (!alternateVersions.has(version)) {
                      alternateVersions.add(version);
                      report.conflicts = (report.conflicts ?? 0) + 1;
                      recordRecovery(
                        receipt,
                        'conflict',
                        table.name,
                        'An alternate damaged view disagrees with the retained row; no timestamp proves it newer',
                        row,
                        source,
                      );
                    }
                    return;
                  }
                  update.run(...updates.map((c) => row[c] ?? null), ...values);
                  report.merged++;
                };
                let complete = false;
                try {
                  complete = readRows(snap.db, source, table, (row) => {
                    const key = rowKey(row, identity);
                    thisRead.add(key);
                    if (view === views[0]) {
                      const newest = newestKeys.get(table.name) ?? new Set<string>();
                      newest.add(key);
                      newestKeys.set(table.name, newest);
                    }
                    const first = !seen.has(key);
                    if (first) {
                      seen.add(key);
                      report.salvaged++;
                    }
                    if (missing.length > 0 && first)
                      recordRecovery(
                        receipt,
                        'unmerged-columns',
                        table.name,
                        `Columns outside the current schema: ${missing.join(', ')}`,
                        row,
                      );
                    // A complete WAL view proves that an older main-only row was deleted.
                    if (authority.has(table.name) && !authority.get(table.name)?.has(key)) {
                      recordDeleted(
                        table.name,
                        row,
                        identity,
                        'Readable only in an older main-only view; absent from the complete WAL view',
                      );
                      return;
                    }
                    try {
                      apply(row, first);
                    } catch {
                      pending.push(() => {
                        try {
                          apply(row, first);
                        } catch (error) {
                          report.conflicts = (report.conflicts ?? 0) + 1;
                          recordRecovery(
                            receipt,
                            'conflict',
                            table.name,
                            error instanceof Error ? error.message : String(error),
                            row,
                            source,
                          );
                        }
                      });
                    }
                  });
                } catch (error) {
                  receipt.diagnostics.push(
                    `${table.name}: ${error instanceof Error ? error.message : String(error)}`,
                  );
                }
                if (
                  !preserveHistory &&
                  (source === views[0] || source === `${views[0]}.header-recovered`) &&
                  complete &&
                  !incompleteSchema
                )
                  authority.set(table.name, thisRead);
                if (!complete) {
                  report.unreadable = null;
                  receipt.diagnostics.push(
                    `${table.name}: unreadable b-tree ranges; their row count is unknown`,
                  );
                }
              }
            } finally {
              snap.close();
            }
          }
        }
        for (const [name, base] of baseKeys) {
          const table = tables(db, receipt.diagnostics, staged).find((t) => t.name === name);
          if (!table) continue;
          const cols = columns(db, name);
          let identity = cols
            .filter((c) => c.pk > 0)
            .sort((a, b) => a.pk - b.pk)
            .map((c) => c.name);
          if (identity.length === 0)
            identity = hasRowid(table.sql) ? [ROWID] : cols.map((c) => c.name);
          const current = db.prepare(
            `SELECT ${identity.includes(ROWID) ? `_rowid_ AS ${repairIdentifier(ROWID)}, ` : ''}* FROM main.${repairIdentifier(name)}`,
          );
          current.setReadBigInts(true);
          const rows = current.all();
          const authoritative = authority.get(name);
          const report = reportFor(name);
          for (const row of rows) {
            const key = rowKey(row, identity);
            if (authoritative ? authoritative.has(key) : newestKeys.get(name)?.has(key)) continue;
            if (!base.has(key)) continue;
            if (!authoritative) {
              report.possiblyResurrected = (report.possiblyResurrected ?? 0) + 1;
              recordRecovery(
                receipt,
                'possibly-resurrected',
                name,
                preserveHistory
                  ? 'Newer history retained: the stale live view cannot prove deletion'
                  : 'Incomplete damaged read cannot prove this snapshot row was deleted',
                row,
              );
              continue;
            }
            const where = identity
              .map(
                (c) =>
                  `${repairIdentifier(c === ROWID ? '_rowid_' : c)} ${c === ROWID ? '=' : 'IS'} ?`,
              )
              .join(' AND ');
            const del = db.prepare(`DELETE FROM main.${repairIdentifier(name)} WHERE ${where}`);
            del.setReadBigInts(true);
            del.run(...identity.map((c) => row[c] ?? null));
            removeBase(name, row, identity);
            recordDeleted(name, row, identity, 'Absent from a complete damaged view');
          }
        }
        for (const retry of pending) retry();
        // Removing one orphan may expose a child orphan; converge with all actions disabled.
        for (;;) {
          const check = db.prepare('PRAGMA foreign_key_check');
          check.setReadBigInts(true);
          const violations = check.all();
          if (violations.length === 0) break;
          let removed = 0;
          for (const violation of violations) {
            const name = String(violation.table);
            const q = repairIdentifier(name);
            const pk = columns(db, name)
              .filter((c) => c.pk > 0)
              .sort((a, b) => a.pk - b.pk)
              .map((c) => c.name);
            const identity = pk.length ? pk : [ROWID];
            for (const row of orphanRows(db, violation)) {
              recordRecovery(
                receipt,
                'conflict',
                name,
                `Foreign key ${violation.fkid} references unreadable or absent ${violation.parent}`,
                row,
              );
              const report = reportFor(name);
              report.conflicts = (report.conflicts ?? 0) + 1;
              removeBase(name, row, identity);
              const where = identity
                .map(
                  (c) =>
                    `${repairIdentifier(c === ROWID ? '_rowid_' : c)} ${c === ROWID ? '=' : 'IS'} ?`,
                )
                .join(' AND ');
              const del = db.prepare(`DELETE FROM main.${q} WHERE ${where}`);
              del.setReadBigInts(true);
              del.run(...identity.map((c) => row[c] ?? null));
              removed++;
            }
          }
          if (removed === 0)
            // @sync-invariant none:local-only unexpected foreign-key schema prevents a safe staged publication
            throw new Error('Foreign-key violations could not be isolated to readable rows');
        }
        for (const table of virtual.values()) {
          if (
            /\bUSING\s+fts[345]\b/i.test(table.sql) &&
            /\bcontent\s*=/i.test(table.sql) &&
            !contentlessFts(table)
          ) {
            const q = repairIdentifier(table.name);
            db.exec(`INSERT INTO main.${q} (${q}) VALUES ('rebuild')`);
          }
        }
        for (const trigger of originalTriggers)
          if (typeof trigger.sql === 'string') db.exec(trigger.sql);
      });
      db.exec('COMMIT');
    } catch (error) {
      db.exec('ROLLBACK');
      throw error;
    }
  } finally {
    target.close();
  }
  return function mergeRecoveredJournal(): void {
    if (journal.length === 0) return;
    const target = openCleoDbSnapshot(staged, {
      readOnly: false,
      applyPragmas: false,
      loadSqliteVec: true,
    });
    try {
      const names = columns(target.db, '__drizzle_migrations').map((c) => c.name);
      const find = target.db.prepare(
        'SELECT 1 FROM main.__drizzle_migrations WHERE id = ? OR hash = ?',
      );
      // gate-28: staged-snapshot mergeRecoveredJournal
      const ins = target.db.prepare(
        `INSERT INTO main.__drizzle_migrations (${names.map(repairIdentifier).join(',')}) VALUES (${names.map(() => '?').join(',')})`,
      );
      ins.setReadBigInts(true);
      for (const row of journal) {
        if (find.get(row.id ?? null, row.hash ?? null)) continue;
        try {
          ins.run(...names.map((name) => row[name] ?? null));
          const report = receipt.tables.__drizzle_migrations;
          if (report) report.merged++;
        } catch (error) {
          recordRecovery(
            receipt,
            'conflict',
            '__drizzle_migrations',
            error instanceof Error ? error.message : String(error),
            row,
          );
        }
      }
    } finally {
      target.close();
    }
  };
}
