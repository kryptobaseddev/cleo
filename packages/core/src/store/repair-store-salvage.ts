/** Copy-only SQLite salvage. No handle in this module ever opens the live store. */
import { spawnSync } from 'node:child_process';
import { closeSync, existsSync, openSync, readSync, realpathSync, statSync } from 'node:fs';
import { basename } from 'node:path';
import type { DatabaseSync, SQLOutputValue, StatementSync } from 'node:sqlite';
import type { StoreRepairReceipt } from '@cleocode/contracts/db-recovery.js';
import { openCleoDbSnapshot } from './open-cleo-db.js';
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

/** Stream readable rows; isolate bad pages without scanning an unbounded integer keyspace. */
function readRows(
  db: DatabaseSync,
  file: string,
  table: Table,
  accept: (row: Row) => void,
): boolean {
  const q = repairIdentifier(table.name);
  const rowid = !/\bWITHOUT\s+ROWID\b/i.test(table.sql) && !/\bVIRTUAL\s+TABLE\b/i.test(table.sql);
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
  for (const row of db.prepare("SELECT name FROM main.sqlite_schema WHERE type='table'").all()) {
    const table = String(row.name);
    counts[table] = Number(
      db.prepare(`SELECT count(*) AS n FROM main.${repairIdentifier(table)}`).get()?.n,
    );
  }
  return counts;
}

/**
 * Merge every readable key from the two private damaged views and .recover.
 * Raw writes target only the staged snapshot, never a live store (gate 28).
 * Guard and side-effect suspension is a snapshot rewind; suspect accounting
 * after migration makes sync's normal repair diff journal the recovered rows.
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
  const journal: Row[] = [];
  const journalKeys = new Set<string>();
  const target = openCleoDbSnapshot(staged, {
    readOnly: false,
    applyPragmas: false,
    loadSqliteVec: true,
  });
  try {
    const db = target.db;
    // Recovery preserves shadow rows too; this handle can only name a staged copy.
    if ('enableDefensive' in db && typeof db.enableDefensive === 'function')
      db.enableDefensive(false);
    db.exec('PRAGMA foreign_keys=OFF');
    ensureTriggerSuspendTable(db);
    const originalTriggers = db
      .prepare("SELECT name, sql FROM main.sqlite_schema WHERE type='trigger'")
      .all();
    const targetTables = new Set(tables(db, receipt.diagnostics, staged).map((t) => t.name));
    const keys = new Map<string, Set<string>>();
    db.exec('BEGIN IMMEDIATE');
    try {
      withTriggersSuspended(db, ['all'], 'rewind', () => {
        // Legacy and derived triggers do not all carry the suspension clause.
        for (const trigger of originalTriggers)
          db.exec(`DROP TRIGGER ${repairIdentifier(String(trigger.name))}`);
        for (const view of views) {
          // Fold only a disposable copy's valid WAL prefix into its main file.
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
          for (const source of recovered ? [view, recovered] : [view]) {
            let snap: ReturnType<typeof openCleoDbSnapshot>;
            try {
              snap = openCleoDbSnapshot(source, { applyPragmas: false, loadSqliteVec: true });
            } catch (error) {
              receipt.diagnostics.push(
                `open ${source}: ${error instanceof Error ? error.message : String(error)}`,
              );
              continue;
            }
            try {
              for (const table of tables(snap.db, receipt.diagnostics, source)) {
                if (table.name === 'cleo_trigger_suspend' || table.name === 'sqlite_sequence')
                  continue;
                if (!targetTables.has(table.name)) {
                  const exists = db
                    .prepare("SELECT 1 FROM main.sqlite_schema WHERE type='table' AND name=?")
                    .get(table.name);
                  if (!exists) {
                    if (!/^\s*CREATE\s+(?:VIRTUAL\s+)?TABLE\b/i.test(table.sql)) {
                      // @sync-invariant none:input-shape a recovered schema row must declare a table
                      throw new Error(`Invalid recovered table definition: ${table.name}`);
                    }
                    const ddl = db.prepare(table.sql);
                    ddl.setReadBigInts(true);
                    ddl.run();
                  }
                  targetTables.add(table.name);
                }
                receipt.tables[table.name] ??= {
                  snapshot: 0,
                  salvaged: 0,
                  merged: 0,
                  unreadable: 0,
                  final: 0,
                };
                const report = receipt.tables[table.name];
                if (table.name === '__drizzle_migrations') {
                  // Imported stamps cannot make pending base-schema migrations disappear.
                  readRows(snap.db, source, table, (row) => {
                    const key = String(row.id ?? row[ROWID]);
                    if (!journalKeys.has(key)) {
                      journalKeys.add(key);
                      journal.push(row);
                      report.salvaged++;
                    }
                  });
                  continue;
                }
                const destColumns = columns(db, table.name);
                const incoming = new Set(columns(snap.db, table.name).map((c) => c.name));
                const common = destColumns.filter((c) => incoming.has(c.name)).map((c) => c.name);
                let pk = destColumns
                  .filter((c) => c.pk > 0)
                  .sort((a, b) => a.pk - b.pk)
                  .map((c) => c.name);
                const implicit = pk.length === 0 && !/\bVIRTUAL\s+TABLE\b/i.test(table.sql);
                if (implicit) {
                  pk = [ROWID];
                  common.unshift(ROWID);
                }
                const col = (c: string): string => repairIdentifier(c === ROWID ? '_rowid_' : c);
                const q = `main.${repairIdentifier(table.name)}`;
                const where =
                  pk.length > 0
                    ? pk.map((c) => `${col(c)} IS ?`).join(' AND ')
                    : common.map((c) => `${col(c)} IS ?`).join(' AND ');
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
                  stamp && updates.length > 0
                    ? db.prepare(
                        `UPDATE ${q} SET ${updates.map((c) => `${col(c)}=?`).join(',')} WHERE ${where}`,
                      )
                    : null;
                const seen = keys.get(table.name) ?? new Set<string>();
                keys.set(table.name, seen);
                const complete = readRows(snap.db, source, table, (row) => {
                  const identity = pk.length > 0 ? pk : common;
                  const values = identity.map((c) => row[c] ?? null);
                  const key = JSON.stringify(values, (_key, value) =>
                    typeof value === 'bigint' ? value.toString() : value,
                  );
                  if (!seen.has(key)) {
                    seen.add(key);
                    report.salvaged++;
                  }
                  const old = find.get(...values);
                  if (!old) {
                    ins.run(...common.map((c) => row[c] ?? null));
                    report.merged++;
                  } else if (stamp && update && timestamp(row[stamp]) > timestamp(old[stamp])) {
                    update.run(...updates.map((c) => row[c] ?? null), ...values);
                    report.merged++;
                  }
                });
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
      target.db.exec('BEGIN IMMEDIATE');
      try {
        for (const row of journal) {
          if (find.get(row.id ?? null, row.hash ?? null)) continue;
          ins.run(...names.map((name) => row[name] ?? null));
          const report = receipt.tables.__drizzle_migrations;
          if (report) report.merged++;
        }
        target.db.exec('COMMIT');
      } catch (error) {
        target.db.exec('ROLLBACK');
        throw error;
      }
    } finally {
      target.close();
    }
  };
}
