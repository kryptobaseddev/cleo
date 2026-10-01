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

/**
 * Version of the manifest computation; recorded as the manifest's
 * `schemaVersion`. 2: non-syncing columns hash as NULL, plus the
 * `zz_vault_db_*` and `zz_vault_files` entries (T12967, T12969).
 */
export const VAULT_MANIFEST_SCHEMA_VERSION = 2;

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
        // An unencrypted bundle clears credential columns in every database it
        // carries, so even an unclassified database hashes them as NULL.
        const cleared = new Set(
          opts.allTables === true
            ? (CREDENTIAL_COLUMNS[name] ?? [])
            : vaultLocalColumns(opts.scope, name),
        );
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
  /** Tables whose rows now come whole from the live store (`local-only`, or a `portable-secret` table without a stable key). */
  preserved: string[];
  /** Tables (and their columns) whose non-syncing cells were merged from live rows by a stable key. */
  carried: Array<{ table: string; columns: string[]; rows: number }>;
  /** Tables left as the snapshot had them (absent here, shaped differently, or without a stable key). */
  skipped: string[];
  /** Live credentials that could not be kept, with their remedy. */
  lost: VaultLostCredentials[];
  /** Snapshot-only rows whose foreign local paths were cleared or marked remote, per table. */
  scrubbed: Array<{ table: string; rows: number }>;
}

/** Options of {@link carryMachineState}. */
export interface CarryMachineStateOptions {
  /**
   * The root the snapshot was taken at, when the restore relocates it onto
   * this machine afterwards (a project store): paths under it are kept, since
   * the relocation rewrites them. `null` (a global store): no path is relocated.
   */
  snapshotRoot: string | null;
}

/**
 * Prefix of the value a NOT NULL machine-local path cell gets in a row that
 * only another machine has (a project or skill not on this machine): a
 * placeholder, not a path, so nothing here reads it as a missing directory
 * (`cleo nexus projects clean --orphans` never removes such a row).
 */
export const VAULT_REMOTE_PATH_PREFIX = 'cleo-vault-remote:';

/**
 * Whether a path cell is the placeholder of a row another machine holds.
 *
 * @param value - A path column value.
 * @returns `true` for {@link VAULT_REMOTE_PATH_PREFIX} values.
 */
export function isVaultRemotePath(value: string | null | undefined): boolean {
  return typeof value === 'string' && value.startsWith(VAULT_REMOTE_PATH_PREFIX);
}

type Cell = string | number | bigint | null | Uint8Array;

function hasValue(v: unknown): boolean {
  return v !== null && v !== undefined && v !== '';
}

interface ColumnInfo {
  name: string;
  pk: number;
  type: string;
  notnull: number;
}

/**
 * The columns rows are matched on across machines: the primary key when it is
 * stable, else the first non-partial UNIQUE index whose columns both stores
 * have (a natural key, e.g. `skills_skills.name`, `accounts(provider, label)`).
 * An integer primary key (a rowid alias or AUTOINCREMENT) is minted per
 * machine, so it is never used. `null` when there is no stable key.
 */
function stableKey(
  db: DatabaseSync,
  table: string,
  sql: string,
  info: readonly ColumnInfo[],
  common: ReadonlySet<string>,
): { key: string[]; unstablePk: string[] } | null {
  const pk = info
    .filter((c) => c.pk > 0)
    .sort((x, y) => x.pk - y.pk)
    .map((c) => c.name);
  const unstablePk = /\bAUTOINCREMENT\b/i.test(sql)
    ? pk
    : info.filter((c) => c.pk > 0 && /INT/i.test(c.type)).map((c) => c.name);
  if (pk.length > 0 && unstablePk.length === 0) {
    return pk.every((k) => common.has(k)) ? { key: pk, unstablePk } : null;
  }
  const indexes = (
    db.prepare(`PRAGMA index_list(${quoteIdent(table)})`).all() as Array<{
      name: string;
      unique: number;
      origin: string;
      partial: number;
    }>
  ).filter((i) => i.unique === 1 && i.partial === 0 && i.origin !== 'pk');
  for (const i of indexes.sort((x, y) => (x.origin === 'u' ? 0 : 1) - (y.origin === 'u' ? 0 : 1))) {
    const cols = (
      db.prepare(`PRAGMA index_info(${quoteIdent(i.name)})`).all() as Array<{ name: string | null }>
    ).map((c) => c.name);
    if (cols.length > 0 && cols.every((c): c is string => c !== null && common.has(c))) {
      return { key: cols as string[], unstablePk };
    }
  }
  return null;
}

/**
 * Before a vault restore activates a snapshot, carry this machine's own state
 * into the staged copy, so a pull never replaces it with another device's
 * (or with the empty cells an unencrypted bundle carries):
 *
 * - `local-only` tables: all rows come from the live store (replica binding,
 *   machine state); a table absent here is emptied.
 * - `portable-secret` tables: live rows are upserted by a stable key (the
 *   snapshot's copies arrive with their secrets cleared). Without a stable
 *   key the live table is kept whole.
 * - Every other table: its non-syncing columns ({@link vaultLocalColumns}:
 *   credentials, machine-local paths, stripped values) are copied from the
 *   live row with the same stable key. A table without one is skipped and
 *   reported; rows are never matched by an integer id, which each machine
 *   mints for itself.
 * - Rows only the snapshot has (a project or skill on another machine only)
 *   never bring that machine's local paths: a non-syncing cell holding an
 *   absolute path outside `snapshotRoot` is cleared (NULL), or, when the
 *   column is NOT NULL, set to a {@link VAULT_REMOTE_PATH_PREFIX} placeholder
 *   that is not a path and is never treated as an orphan.
 *
 * Syncing cells keep the snapshot's values (they are what the manifest
 * verified; non-syncing cells hash as NULL, so none of this changes the
 * manifest). A whole table is carried only when it has the same columns in
 * both stores; a column merge uses the columns both have. A live credential
 * that has nowhere to go is reported in `lost` with its re-entry remedy.
 *
 * @param stagedDbPath - The staged snapshot database (written in place).
 * @param liveDbPath - This machine's current database (read only).
 * @param scope - Which `cleo.db` this is.
 * @param opts - The snapshot's root (see {@link CarryMachineStateOptions}).
 * @returns What was carried, skipped, lost and scrubbed.
 */
export function carryMachineState(
  stagedDbPath: string,
  liveDbPath: string,
  scope: TableScope,
  opts: CarryMachineStateOptions = { snapshotRoot: null },
): CarriedMachineState {
  const out: CarriedMachineState = {
    preserved: [],
    carried: [],
    skipped: [],
    lost: [],
    scrubbed: [],
  };
  const live = new DatabaseSync(liveDbPath, { readOnly: true });
  const staged = new DatabaseSync(stagedDbPath); // schema-guard-exempt: the staged restore copy this step owns; carrying machine state is DML only
  const snapshotRoot = opts.snapshotRoot === null ? null : opts.snapshotRoot.replace(/[\\/]+$/, '');
  try {
    const tablesOf = (db: DatabaseSync) =>
      new Map(
        (
          db
            .prepare(
              "SELECT name, sql FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' AND sql NOT LIKE 'CREATE VIRTUAL TABLE%'",
            )
            .all() as Array<{ name: string; sql: string | null }>
        ).map((r) => [r.name, r.sql ?? '']),
      );
    const infoOf = (db: DatabaseSync, t: string) =>
      db.prepare(`PRAGMA table_info(${quoteIdent(t)})`).all() as unknown as ColumnInfo[];
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
    const keyOf = (r: Record<string, Cell>, key: readonly string[]) => {
      const values = key.map((k) => r[k] ?? null);
      return values.some((v) => v === null) ? null : JSON.stringify(values.map((v) => String(v)));
    };
    const underSnapshotRoot = (v: string) =>
      snapshotRoot !== null &&
      (v === snapshotRoot ||
        (v.startsWith(snapshotRoot) && /^[\\/]/.test(v.slice(snapshotRoot.length))));
    // An absolute path a restore will not relocate onto this machine (only a
    // relocatable column under the snapshot's root is rewritten by it).
    const foreignPath = (v: Cell, relocatable: boolean) =>
      typeof v === 'string' &&
      !isVaultRemotePath(v) &&
      (v.startsWith('/') || /^[A-Za-z]:[\\/]/.test(v) || v.startsWith('\\\\')) &&
      !(relocatable && underSnapshotRoot(v));
    staged.exec('PRAGMA foreign_keys = OFF');
    staged.exec('BEGIN IMMEDIATE');
    try {
      for (const [t, sql] of [...tablesOf(staged)].sort(([a], [b]) =>
        a < b ? -1 : a > b ? 1 : 0,
      )) {
        const c = classifyTable(scope, t);
        if (c.kind !== 'entry' && c.kind !== 'pattern') continue;
        const credentialCols = CREDENTIAL_COLUMNS[t] ?? [];
        const stagedInfo = infoOf(staged, t);
        const stagedCols = stagedInfo.map((x) => x.name);
        const liveInfo = liveTables.has(t) ? infoOf(live, t) : [];
        const liveCols = liveInfo.map((x) => x.name);
        const sameShape = liveCols.join('\u0000') === stagedCols.join('\u0000');
        const holdsSecret = (r: Record<string, Cell>) =>
          c.class === 'portable-secret' || credentialCols.some((k) => hasValue(r[k]));
        const replaceWhole = (rows: ReadonlyArray<Record<string, Cell>>) => {
          staged.prepare(`DELETE FROM ${quoteIdent(t)}`).run();
          insertRows(staged, t, liveCols, rows);
          out.preserved.push(t);
        };

        if (c.class === 'local-only') {
          // Machine state never comes from another machine: a table this store
          // does not have yet is emptied, not filled with the pusher's rows.
          if (!liveTables.has(t)) {
            staged.prepare(`DELETE FROM ${quoteIdent(t)}`).run();
            out.preserved.push(t);
          } else if (!sameShape) {
            out.skipped.push(t);
          } else {
            replaceWhole(rowsOf(live, t));
          }
          continue;
        }

        const common = new Set(stagedCols.filter((n) => liveCols.includes(n)));
        const local = vaultLocalColumns(scope, t).filter((n) => stagedCols.includes(n));
        if (c.class !== 'portable-secret' && local.length === 0) continue;
        const liveRows = liveTables.has(t) ? rowsOf(live, t) : [];
        const stable = stableKey(staged, t, sql, stagedInfo, common);
        const liveKeys = new Set<string>();

        if (stable === null) {
          if (c.class === 'portable-secret' && liveTables.has(t) && sameShape) {
            // No key to match rows by: this machine's secrets are kept whole.
            replaceWhole(liveRows);
            continue;
          }
          if (liveRows.length > 0) out.skipped.push(t);
          lose(t, liveRows.filter(holdsSecret).length);
        } else {
          const { key, unstablePk } = stable;
          const merge =
            c.class === 'portable-secret'
              ? [...common].filter((n) => !key.includes(n) && !unstablePk.includes(n))
              : local.filter((n) => common.has(n));
          const where = key.map((k) => `${quoteIdent(k)} = ?`).join(' AND ');
          const exists = staged.prepare(`SELECT 1 FROM ${quoteIdent(t)} WHERE ${where} LIMIT 1`);
          const update =
            merge.length > 0
              ? staged.prepare(
                  `UPDATE ${quoteIdent(t)} SET ${merge.map((k) => `${quoteIdent(k)} = ?`).join(', ')} WHERE ${where}`,
                )
              : null;
          // A live-only secret row is inserted without its machine-minted integer id.
          const cols = [...common].filter((n) => !unstablePk.includes(n));
          const insert = staged.prepare(
            `INSERT INTO ${quoteIdent(t)} (${cols.map(quoteIdent).join(', ')}) VALUES (${cols.map(() => '?').join(', ')})`,
          );
          let rows = 0;
          let lost = 0;
          for (const r of liveRows) {
            const k = keyOf(r, key);
            if (k === null) {
              if (holdsSecret(r)) lost += 1;
              continue;
            }
            liveKeys.add(k);
            const keyValues = key.map((col) => r[col] ?? null);
            try {
              if (exists.get(...keyValues) !== undefined) {
                update?.run(...merge.map((col) => r[col] ?? null), ...keyValues);
                rows += 1;
              } else if (c.class === 'portable-secret') {
                // A secret row this machine holds and the snapshot lacks: keep it.
                insert.run(...cols.map((col) => r[col] ?? null));
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

        // Rows only the snapshot has never bring another machine's local paths.
        if (c.class === 'portable-secret') continue;
        // Any non-syncing cell holding an absolute path the restore will not relocate.
        const pathCols = local;
        if (pathCols.length === 0 || /WITHOUT ROWID/i.test(sql)) continue;
        const notNull = new Set(stagedInfo.filter((x) => x.notnull === 1).map((x) => x.name));
        const scrubKey = stable?.key ?? null;
        let scrubbed = 0;
        const select = staged.prepare(`SELECT rowid AS rid, * FROM ${quoteIdent(t)}`);
        select.setReadBigInts(true);
        for (const r of select.all() as Array<Record<string, Cell>>) {
          const k = scrubKey === null ? null : keyOf(r, scrubKey);
          if (k !== null && liveKeys.has(k)) continue;
          const sets: string[] = [];
          const values: Cell[] = [];
          for (const col of pathCols) {
            if (!foreignPath(r[col] ?? null, relocatableColumn(t, col, false) === 'path')) continue;
            sets.push(`${quoteIdent(col)} = ?`);
            values.push(
              notNull.has(col)
                ? `${VAULT_REMOTE_PATH_PREFIX}${t}:${k ?? String(r['rid'])}:${col}`
                : null,
            );
          }
          if (sets.length === 0) continue;
          staged
            .prepare(`UPDATE ${quoteIdent(t)} SET ${sets.join(', ')} WHERE rowid = ?`)
            .run(...values, r['rid'] ?? null);
          scrubbed += 1;
        }
        if (scrubbed > 0) out.scrubbed.push({ table: t, rows: scrubbed });
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
