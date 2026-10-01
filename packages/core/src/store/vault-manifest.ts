/**
 * The cloud vault's snapshot manifest: per-table row counts and keyed hashes
 * of a `cleo.db`, computed the same way on every machine so two machines can
 * tell whether they hold the same data (T12336, T12950).
 *
 * - Only tables whose class syncs across devices are listed
 *   ({@link isPortableTableClass}), minus `portable-secret` (a vault bundle
 *   never carries credentials). Local-only, derived, pending and unclassified
 *   tables differ per machine by design and are left out.
 * - A table's hash is HMAC-SHA256, keyed by a key derived from the stream's
 *   data key, over the sorted per-row SHA-256 digests. Sorting makes it
 *   independent of physical row order (a VACUUM can renumber rowids), and the
 *   key keeps the plaintext manifest from being a dictionary oracle for the
 *   server: it sees counts, never guessable digests.
 * - Cells a restore relocates (path and JSON locator columns, as
 *   {@link relocatableColumn} decides) are hashed as if relocated to a
 *   placeholder root, so a relocated store hashes the same as its source.
 *   Historical text, which a restore leaves as written, is hashed as is.
 * - Cells that never sync hash as NULL ({@link vaultLocalColumns}): credential
 *   columns (an unencrypted bundle clears them) and every column the
 *   classification registry gives its own `local-only`, `portable-secret` or
 *   `strip` class. A restore keeps this machine's values for them
 *   ({@link carryMachineState}), so the two sides must agree without them.
 * - The rest of a snapshot (other primary databases, plain files) is folded
 *   into pseudo-table entries ({@link vaultDatabaseEntry},
 *   {@link vaultFilesEntry}) so a change anywhere in the bundle is seen.
 *
 * @task T12336
 * @epic T12322
 */

import crypto from 'node:crypto';
import { createRequire } from 'node:module';
import type { DatabaseSync as _DatabaseSyncType } from 'node:sqlite';
import type { TableScope } from '@cleocode/contracts';
import { relocatableColumn, relocateCell } from './portable-bundle-relocate.js';
import { CREDENTIAL_COLUMNS, credentialRemedy } from './portable-bundle-scan.js';
import { applyPerfPragmas } from './sqlite-pragmas.js';
import { classifyTable, isPortableTableClass } from './table-classification.js';

// node:sqlite interop (createRequire — Vitest strips `node:` prefix)
const _require = createRequire(import.meta.url);
type DatabaseSync = _DatabaseSyncType;
const { DatabaseSync } = _require('node:sqlite') as {
  DatabaseSync: new (...args: ConstructorParameters<typeof _DatabaseSyncType>) => DatabaseSync;
};

/** Version of the manifest computation; recorded as the manifest's `schemaVersion`. */
export const VAULT_MANIFEST_SCHEMA_VERSION = 1;

/** A manifest key the wire contract accepts. */
const MANIFEST_KEY = /^[a-z][a-z0-9_]{0,62}$/;

/** Root that relocatable cells are re-rooted onto before hashing. */
const ROOT_PLACEHOLDER = '\u0000CLEO_ROOT\u0000';

/** One table's count and keyed hash. */
export interface VaultTableEntry {
  /** Row count. */
  rows: number;
  /** HMAC-SHA256 hex. */
  hash: string;
}

/** A snapshot manifest, in the wire shape (`Manifest` of the Nexus contract). */
export interface VaultManifest {
  /** {@link VAULT_MANIFEST_SCHEMA_VERSION}. */
  schemaVersion: number;
  /** Per table. */
  tables: Record<string, VaultTableEntry>;
}

/** Manifest key of a snapshot's plain-file inventory (rows: files, hash: keyed inventory hash). */
export const VAULT_FILES_KEY = 'zz_vault_files';

/** Prefix of the manifest key of each primary database other than `cleo.db`. */
export const VAULT_DB_KEY_PREFIX = 'zz_vault_db_';

/**
 * The manifest key of a non-`cleo.db` primary database, from its path in the
 * section (`blobs/manifest.db` -> `zz_vault_db_blobs_manifest_db`).
 *
 * @param relPath - Path relative to the section root.
 * @returns A key the wire contract accepts.
 */
export function vaultDatabaseKey(relPath: string): string {
  const slug = relPath
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '');
  const key = `${VAULT_DB_KEY_PREFIX}${slug}`;
  if (key.length <= 63) return key;
  const digest = crypto.createHash('sha256').update(relPath).digest('hex').slice(0, 8);
  return `${key.slice(0, 54)}_${digest}`;
}

/**
 * Columns of `table` that never sync, so the vault neither compares nor
 * restores them over this machine's values: credential columns
 * ({@link CREDENTIAL_COLUMNS}) and whole-column overrides of the
 * classification registry (`local-only`, `portable-secret`, `strip`). A
 * JSON-path override (part of a value) does not exclude the column.
 *
 * @param scope - Store scope.
 * @param table - Table name.
 * @returns Column names (possibly absent from the actual table).
 */
export function vaultLocalColumns(scope: TableScope, table: string): readonly string[] {
  const out = new Set(CREDENTIAL_COLUMNS[table] ?? []);
  const c = classifyTable(scope, table);
  if (c.kind === 'entry') {
    for (const col of c.entry.columns ?? []) if (col.jsonPath === undefined) out.add(col.column);
  }
  return [...out];
}

/** Options for {@link buildVaultManifest}. */
export interface BuildVaultManifestOptions {
  /** Which `cleo.db` this is (decides the table classes). */
  scope: TableScope;
  /** List every table, classified or not (a primary database other than `cleo.db`). */
  allTables?: boolean;
  /** Key the hashes are made with (derive it from the stream data key). */
  hashKey: Uint8Array;
  /** The store's root as written in its rows; relocatable cells are re-rooted from it. `null`: none (a store a restore does not relocate). */
  root: string | null;
}

/** The manifest plus the tables left out, for reports. */
export interface VaultManifestBuild {
  manifest: VaultManifest;
  /** Syncing tables whose name the wire contract cannot carry. */
  skipped: string[];
}

/**
 * Whether a table belongs in a vault manifest of `scope`.
 *
 * @param scope - Store scope.
 * @param name - Physical table name.
 * @returns `true` for syncing, non-secret tables.
 */
export function isVaultManifestTable(scope: TableScope, name: string): boolean {
  const c = classifyTable(scope, name);
  if (c.kind === 'pending' || c.kind === 'unclassified') return false;
  return isPortableTableClass(c.class) && c.class !== 'portable-secret';
}

function canonicalValue(v: unknown, relocate: ((s: string) => string) | null): unknown {
  if (v === null || v === undefined) return null;
  if (typeof v === 'bigint') return { i: v.toString() };
  if (typeof v === 'number') return Number.isInteger(v) ? { i: String(v) } : { f: v };
  if (typeof v === 'string') return relocate ? relocate(v) : v;
  if (v instanceof Uint8Array) return { b: Buffer.from(v).toString('hex') };
  return String(v);
}

function quoteIdent(name: string): string {
  return `"${name.replace(/"/g, '""')}"`;
}

/**
 * Build the vault manifest of one `cleo.db`.
 *
 * Opens the file read-only; the caller passes a snapshot (a staged bundle
 * copy) or the live store, whose single read transaction keeps it consistent.
 *
 * @param dbPath - The database file.
 * @param opts - Scope, hash key and root to normalise.
 * @returns The manifest and the tables skipped for their name.
 */
export function buildVaultManifest(
  dbPath: string,
  opts: BuildVaultManifestOptions,
): VaultManifestBuild {
  const key = Buffer.from(opts.hashKey);
  const root = opts.root === null ? '' : opts.root.replace(/[\\/]+$/, '');
  const tables: Record<string, VaultTableEntry> = {};
  const skipped: string[] = [];
  const db = new DatabaseSync(dbPath, { readOnly: true });
  try {
    applyPerfPragmas(db, { enableWal: false });
    db.exec('BEGIN');
    try {
      const all = db
        .prepare(
          "SELECT name, sql FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name",
        )
        .all() as Array<{ name: string; sql: string | null }>;
      const isVirtual = (t: { sql: string | null }) =>
        (t.sql ?? '').toUpperCase().startsWith('CREATE VIRTUAL TABLE');
      const virtualNames = all.filter(isVirtual).map((t) => t.name);
      const names = all.filter(
        (t) =>
          !isVirtual(t) && (opts.allTables === true || isVaultManifestTable(opts.scope, t.name)),
      );
      for (const { name, sql } of names) {
        if (opts.allTables !== true && !MANIFEST_KEY.test(name)) {
          skipped.push(name);
          continue;
        }
        const digests: Buffer[] = [];
        const cleared = new Set(opts.allTables === true ? [] : vaultLocalColumns(opts.scope, name));
        // Mirror relocateDatabase: virtual-table shadow tables are never relocated.
        const shadow = virtualNames.some((v) => name.startsWith(`${v}_`));
        const withoutRowid = (sql ?? '').toUpperCase().includes('WITHOUT ROWID');
        const relocators = new Map<string, ((s: string) => string) | null>();
        const relocatorOf = (col: string) => {
          if (!relocators.has(col)) {
            const kind = root === '' || shadow ? null : relocatableColumn(name, col, withoutRowid);
            relocators.set(
              col,
              kind === null ? null : (s: string) => relocateCell(kind, s, root, ROOT_PLACEHOLDER),
            );
          }
          return relocators.get(col) ?? null;
        };
        const select = db.prepare(`SELECT * FROM ${quoteIdent(name)}`);
        // Integers past 2^53 (nanosecond times, inode numbers) would throw as numbers.
        select.setReadBigInts(true);
        for (const row of select.iterate()) {
          const values = Object.entries(row as Record<string, unknown>).map(([col, v]) =>
            cleared.has(col) ? null : canonicalValue(v, relocatorOf(col)),
          );
          digests.push(crypto.createHash('sha256').update(JSON.stringify(values)).digest());
        }
        digests.sort(Buffer.compare);
        const mac = crypto.createHmac('sha256', key);
        mac.update(`cleo-vault-table/v1\n${name}\n${digests.length}\n`);
        for (const d of digests) mac.update(d);
        tables[name] = { rows: digests.length, hash: mac.digest('hex') };
      }
    } finally {
      db.exec('COMMIT');
    }
  } finally {
    db.close();
  }
  return { manifest: { schemaVersion: VAULT_MANIFEST_SCHEMA_VERSION, tables }, skipped };
}

/**
 * One manifest entry for a whole primary database other than `cleo.db`
 * (blobs manifest, attachments index): every table, relocation-aware like
 * {@link buildVaultManifest}, folded into one count and keyed hash.
 *
 * @param dbPath - The database file.
 * @param opts - Hash key and root to normalise.
 * @returns Rows over all tables, and the keyed hash over every table's hash.
 */
export function vaultDatabaseEntry(
  dbPath: string,
  opts: { hashKey: Uint8Array; root: string | null },
): VaultTableEntry {
  const { manifest } = buildVaultManifest(dbPath, {
    scope: 'project',
    allTables: true,
    hashKey: opts.hashKey,
    root: opts.root,
  });
  const mac = crypto.createHmac('sha256', Buffer.from(opts.hashKey));
  mac.update('cleo-vault-db/v1\n');
  let rows = 0;
  for (const name of Object.keys(manifest.tables).sort()) {
    const t = manifest.tables[name] as VaultTableEntry;
    rows += t.rows;
    mac.update(`${name}\n${t.rows}\n${t.hash}\n`);
  }
  return { rows, hash: mac.digest('hex') };
}

/**
 * One manifest entry for a snapshot's plain files: the count, and a keyed
 * hash over every (path, sha256) pair, sorted by path.
 *
 * @param files - Files as the bundle manifest lists them.
 * @param hashKey - The manifest hash key.
 * @returns The entry.
 */
export function vaultFilesEntry(
  files: ReadonlyArray<{ relPath: string; sha256: string }>,
  hashKey: Uint8Array,
): VaultTableEntry {
  const mac = crypto.createHmac('sha256', Buffer.from(hashKey));
  mac.update(`cleo-vault-files/v1\n${files.length}\n`);
  for (const f of [...files].sort((a, b) =>
    a.relPath < b.relPath ? -1 : a.relPath > b.relPath ? 1 : 0,
  )) {
    mac.update(`${f.relPath}\u0000${f.sha256}\n`);
  }
  return { rows: files.length, hash: mac.digest('hex') };
}

/** One table's comparison. */
export interface VaultTableComparison {
  table: string;
  localRows: number | null;
  cloudRows: number | null;
  match: boolean;
}

/**
 * Compare two manifests table by table (union of both key sets, sorted).
 *
 * @param local - This side.
 * @param cloud - The other side.
 * @returns One line per table.
 */
export function compareVaultManifests(
  local: Pick<VaultManifest, 'tables'>,
  cloud: Pick<VaultManifest, 'tables'>,
): VaultTableComparison[] {
  const names = [...new Set([...Object.keys(local.tables), ...Object.keys(cloud.tables)])].sort();
  return names.map((table) => {
    const l = local.tables[table];
    const c = cloud.tables[table];
    return {
      table,
      localRows: l?.rows ?? null,
      cloudRows: c?.rows ?? null,
      match: l !== undefined && c !== undefined && l.rows === c.rows && l.hash === c.hash,
    };
  });
}

/**
 * True when two manifests list the same tables with the same counts and hashes.
 *
 * @param a - One manifest.
 * @param b - The other.
 * @returns Whether they are equal.
 */
export function sameVaultManifest(
  a: Pick<VaultManifest, 'tables'>,
  b: Pick<VaultManifest, 'tables'>,
): boolean {
  return compareVaultManifests(a, b).every((t) => t.match);
}

/** Rows this machine held that a restore could not keep. */
export interface VaultLostCredentials {
  table: string;
  /** Rows whose credential or machine-local values were dropped. */
  rows: number;
  /** How to re-enter them. */
  remedy: string;
}

/** What {@link carryMachineState} carried into the staged snapshot. */
export interface CarriedMachineState {
  /** `local-only` tables whose rows now come from the live store. */
  preserved: string[];
  /** Tables (and their columns) whose non-syncing cells were merged from live rows by primary key. */
  carried: Array<{ table: string; columns: string[]; rows: number }>;
  /** Tables left as the snapshot had them (absent here, shaped differently, or without a primary key). */
  skipped: string[];
  /** Live credentials that could not be kept, with their remedy. */
  lost: VaultLostCredentials[];
}

type Cell = string | number | bigint | null | Uint8Array;

function hasValue(v: unknown): boolean {
  return v !== null && v !== undefined && v !== '';
}

/**
 * Before a vault restore activates a snapshot, carry this machine's own state
 * into the staged copy, so a pull never replaces it with another device's
 * (or with the empty cells an unencrypted bundle carries):
 *
 * - `local-only` tables: all rows come from the live store (replica binding,
 *   registry paths and other machine state belong to this machine).
 * - `portable-secret` tables: live rows are upserted by primary key (the
 *   snapshot's copies arrive with their secrets cleared).
 * - Every other table: its non-syncing columns ({@link vaultLocalColumns}:
 *   credentials, machine-local paths, stripped values) are copied from the
 *   live row with the same primary key.
 *
 * Syncing cells keep the snapshot's values (they are what the manifest
 * verified); derived tables are rebuilt from them. A whole table is carried
 * only when it has the same columns in both stores; a column merge uses the
 * columns both have. A live credential that has nowhere to go (its row is
 * gone from the snapshot, or the table cannot be matched by key) is reported
 * in `lost` with its re-entry remedy.
 *
 * @param stagedDbPath - The staged snapshot database (written in place).
 * @param liveDbPath - This machine's current database (read only).
 * @param scope - Which `cleo.db` this is.
 * @returns What was carried, skipped and lost.
 */
export function carryMachineState(
  stagedDbPath: string,
  liveDbPath: string,
  scope: TableScope,
): CarriedMachineState {
  const out: CarriedMachineState = { preserved: [], carried: [], skipped: [], lost: [] };
  const live = new DatabaseSync(liveDbPath, { readOnly: true });
  const staged = new DatabaseSync(stagedDbPath);
  try {
    const tablesOf = (db: DatabaseSync) =>
      new Set(
        (
          db
            .prepare(
              "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' AND sql NOT LIKE 'CREATE VIRTUAL TABLE%'",
            )
            .all() as Array<{ name: string }>
        ).map((r) => r.name),
      );
    const infoOf = (db: DatabaseSync, t: string) =>
      db.prepare(`PRAGMA table_info(${quoteIdent(t)})`).all() as Array<{
        name: string;
        pk: number;
      }>;
    const rowsOf = (db: DatabaseSync, t: string) => {
      const select = db.prepare(`SELECT * FROM ${quoteIdent(t)}`);
      // Integers past 2^53 (nanosecond times, inode numbers) would throw as numbers.
      select.setReadBigInts(true);
      return select.all() as Array<Record<string, Cell>>;
    };
    const liveTables = tablesOf(live);
    const lose = (table: string, rows: number) => {
      if (rows > 0) out.lost.push({ table, rows, remedy: credentialRemedy(table) });
    };
    staged.exec('PRAGMA foreign_keys = OFF');
    staged.exec('BEGIN IMMEDIATE');
    try {
      for (const t of [...tablesOf(staged)].sort()) {
        const c = classifyTable(scope, t);
        if (c.kind !== 'entry' && c.kind !== 'pattern') continue;
        const credentialCols = CREDENTIAL_COLUMNS[t] ?? [];
        const stagedInfo = infoOf(staged, t);
        const liveInfo = liveTables.has(t) ? infoOf(live, t) : [];
        const liveCols = liveInfo.map((x) => x.name);
        const liveRows = liveTables.has(t) ? rowsOf(live, t) : [];
        const holdsSecret = (r: Record<string, Cell>) =>
          c.class === 'portable-secret' || credentialCols.some((k) => hasValue(r[k]));

        if (c.class === 'local-only') {
          // Machine state never comes from another machine: a table this store
          // does not have yet is emptied, not filled with the pusher's rows.
          if (!liveTables.has(t)) {
            staged.prepare(`DELETE FROM ${quoteIdent(t)}`).run();
            out.preserved.push(t);
            continue;
          }
          if (liveCols.join('\u0000') !== stagedInfo.map((x) => x.name).join('\u0000')) {
            out.skipped.push(t);
            continue;
          }
          staged.prepare(`DELETE FROM ${quoteIdent(t)}`).run();
          insertRows(staged, t, liveCols, liveRows);
          out.preserved.push(t);
          continue;
        }

        const pk = stagedInfo
          .filter((x) => x.pk > 0)
          .sort((x, y) => x.pk - y.pk)
          .map((x) => x.name);
        const common = new Set(stagedInfo.map((x) => x.name).filter((n) => liveCols.includes(n)));
        const merge =
          c.class === 'portable-secret'
            ? [...common].filter((n) => !pk.includes(n))
            : vaultLocalColumns(scope, t).filter((n) => common.has(n));
        if (merge.length === 0 && c.class !== 'portable-secret') continue;
        if (liveRows.length === 0) continue;
        if (pk.length === 0 || !pk.every((k) => common.has(k))) {
          out.skipped.push(t);
          lose(t, liveRows.filter(holdsSecret).length);
          continue;
        }
        const where = pk.map((k) => `${quoteIdent(k)} IS ?`).join(' AND ');
        const exists = staged.prepare(`SELECT 1 FROM ${quoteIdent(t)} WHERE ${where} LIMIT 1`);
        const update =
          merge.length > 0
            ? staged.prepare(
                `UPDATE ${quoteIdent(t)} SET ${merge.map((k) => `${quoteIdent(k)} = ?`).join(', ')} WHERE ${where}`,
              )
            : null;
        const cols = [...common];
        const insert = staged.prepare(
          `INSERT INTO ${quoteIdent(t)} (${cols.map(quoteIdent).join(', ')}) VALUES (${cols.map(() => '?').join(', ')})`,
        );
        let rows = 0;
        let lost = 0;
        for (const r of liveRows) {
          const key = pk.map((k) => r[k] ?? null);
          try {
            if (exists.get(...key) !== undefined) {
              update?.run(...merge.map((k) => r[k] ?? null), ...key);
              rows += 1;
            } else if (c.class === 'portable-secret') {
              // A secret row this machine holds and the snapshot lacks: keep it.
              insert.run(...cols.map((k) => r[k] ?? null));
              rows += 1;
            } else if (holdsSecret(r)) {
              lost += 1;
            }
          } catch {
            // A constraint (e.g. a path another snapshot row now owns): the snapshot value stays.
            if (holdsSecret(r)) lost += 1;
          }
        }
        if (rows > 0) out.carried.push({ table: t, columns: merge, rows });
        lose(t, lost);
      }
      staged.exec('COMMIT');
    } catch (err) {
      staged.exec('ROLLBACK');
      throw err;
    }
  } finally {
    staged.close();
    live.close();
  }
  return out;
}

function insertRows(
  db: DatabaseSync,
  table: string,
  cols: readonly string[],
  rows: ReadonlyArray<Record<string, Cell>>,
): void {
  if (rows.length === 0) return;
  const insert = db.prepare(
    `INSERT INTO ${quoteIdent(table)} (${cols.map(quoteIdent).join(', ')}) VALUES (${cols.map(() => '?').join(', ')})`,
  );
  for (const row of rows) insert.run(...cols.map((c) => row[c] ?? null));
}

/**
 * The keyed hash of a table with no rows, as {@link buildVaultManifest} computes it.
 *
 * @param hashKey - The manifest hash key.
 * @param table - Table name.
 * @returns HMAC-SHA256 hex.
 */
export function emptyVaultTableHash(hashKey: Uint8Array, table: string): string {
  return crypto
    .createHmac('sha256', Buffer.from(hashKey))
    .update(`cleo-vault-table/v1\n${table}\n0\n`)
    .digest('hex');
}
