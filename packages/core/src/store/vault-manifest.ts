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
import fs from 'node:fs';
import { createRequire } from 'node:module';
import type { DatabaseSync as _DatabaseSyncType } from 'node:sqlite';
import { SYNC_SCHEMA_VERSION, type TableScope } from '@cleocode/contracts';
import { isVaultRemotePath, VAULT_REMOTE_PATH_PREFIX } from '@cleocode/paths';
import {
  RELOCATED_JSON_FILES,
  relocatableColumn,
  relocateCell,
  relocatedJsonText,
} from './portable-bundle-relocate.js';
import { CREDENTIAL_COLUMNS, credentialRemedy, sha256File } from './portable-bundle-scan.js';
import { applyPerfPragmas } from './sqlite-pragmas.js';
import {
  hasTriggerSuspendTable,
  TRIGGER_SUSPEND_TABLE,
  withTriggersSuspended,
} from './sync/trigger-classes.js';
import { classifyTable, getTableRegistry, isPortableTableClass } from './table-classification.js';

// node:sqlite interop (createRequire — Vitest strips `node:` prefix)
const _require = createRequire(import.meta.url);
type DatabaseSync = _DatabaseSyncType;
const { DatabaseSync } = _require('node:sqlite') as {
  DatabaseSync: new (...args: ConstructorParameters<typeof _DatabaseSyncType>) => DatabaseSync;
};

/**
 * Version of the manifest computation (which cells hash, and how; which
 * pseudo-entries exist). 2: non-syncing columns hash as NULL, plus the
 * `zz_vault_db_*` and `zz_vault_files` entries (T12967, T12969).
 *
 * It is not the manifest's wire `schemaVersion`: that is
 * {@link SYNC_SCHEMA_VERSION}, the stream data numbering the vault shares with
 * the change journal (T13034), and a computation change must not move it (the
 * server reads a rise there as a schema transition every v3 checkpoint pins).
 * The format never reaches the wire: a snapshot hashed under another format
 * compares as changed, never as the same data.
 */
export const VAULT_MANIFEST_FORMAT_VERSION = 2;

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
  /** The wire `schemaVersion`: {@link SYNC_SCHEMA_VERSION} on what the vault writes. */
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

/**
 * Whole columns the classification registry gives the `strip` class (a value
 * stripped from everything that leaves the device, such as a git remote URL,
 * which can embed a token), by table. A vault snapshot never carries them
 * (T13007); like every non-syncing column they hash as NULL and a restore
 * keeps this machine's values.
 *
 * @param scope - Store scope.
 * @returns Table to stripped column names.
 */
export function vaultStripColumns(scope: TableScope): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  for (const [table, entry] of Object.entries(getTableRegistry(scope).tables)) {
    const cols = (entry.columns ?? [])
      .filter((c) => c.class === 'strip' && c.jsonPath === undefined)
      .map((c) => c.column);
    if (cols.length > 0) out[table] = cols;
  }
  return out;
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
  return { manifest: { schemaVersion: SYNC_SCHEMA_VERSION, tables }, skipped };
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

/** A parsed JSON value. */
type JsonValue = string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue };

/** JSON text with every object's keys sorted, so key order is not content. */
function canonicalJson(value: JsonValue): string {
  return JSON.stringify(value, (_key, v: JsonValue) =>
    v !== null && typeof v === 'object' && !Array.isArray(v)
      ? Object.fromEntries(Object.entries(v).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)))
      : v,
  );
}

/**
 * Keys of the global `config.json` that belong to the install, not to the
 * user (T13022): never compared, and a restore keeps this machine's value.
 */
export const VAULT_GLOBAL_CONFIG_LOCAL_KEYS: ReadonlyArray<readonly [string, string]> = [
  ['telemetry', 'installId'],
];

/** Options of {@link vaultFileDigest}. */
export interface VaultFileDigestOptions {
  /** Which store the file belongs to. */
  scope: TableScope;
  /** The store's root as written in the file (project), or `null`. */
  root: string | null;
  /** The file's SHA-256 when already known (a bundle manifest lists it). */
  sha256?: string;
}

/**
 * The digest a vault file inventory records for one plain file (T13005,
 * T13022). Config files are hashed as JSON with sorted keys, so reordering is
 * not a change: the project JSON files a restore relocates
 * ({@link RELOCATED_JSON_FILES}: `config.json`, `project-context.json`) with
 * their paths re-rooted from `root` onto a placeholder, so a relocated copy
 * hashes like its source; the global `config.json` without its install keys
 * ({@link VAULT_GLOBAL_CONFIG_LOCAL_KEYS}). Every other file, and a config
 * file that is not JSON, is its SHA-256.
 *
 * @param absPath - The file.
 * @param relPath - Its path in the section.
 * @param opts - Scope, root and known SHA-256.
 * @returns Hex digest.
 */
export async function vaultFileDigest(
  absPath: string,
  relPath: string,
  opts: VaultFileDigestOptions,
): Promise<string> {
  const project = opts.scope === 'project' && opts.root !== null;
  const globalConfig = opts.scope === 'global' && relPath === 'config.json';
  if ((project && RELOCATED_JSON_FILES.includes(relPath)) || globalConfig) {
    const text = fs.readFileSync(absPath, 'utf8');
    const relocated =
      project && opts.root !== null
        ? relocatedJsonText(text, opts.root.replace(/[\\/]+$/, ''), ROOT_PLACEHOLDER)
        : text;
    let value: JsonValue | undefined;
    try {
      value = relocated === null ? undefined : (JSON.parse(relocated) as JsonValue);
    } catch {
      value = undefined;
    }
    if (value !== undefined) {
      if (globalConfig) value = withoutGlobalConfigLocalKeys(value);
      return crypto
        .createHash('sha256')
        .update(`cleo-vault-json/v2\n${canonicalJson(value)}`)
        .digest('hex');
    }
  }
  return opts.sha256 ?? sha256File(absPath);
}

/** A copy of a parsed global `config.json` without {@link VAULT_GLOBAL_CONFIG_LOCAL_KEYS}. */
function withoutGlobalConfigLocalKeys(value: JsonValue): JsonValue {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return value;
  const out = structuredClone(value);
  for (const [section, key] of VAULT_GLOBAL_CONFIG_LOCAL_KEYS) {
    const inner = out[section];
    if (
      inner !== undefined &&
      inner !== null &&
      typeof inner === 'object' &&
      !Array.isArray(inner)
    ) {
      delete inner[key];
    }
  }
  return out;
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
 * Manifest key that labels a snapshot as a fork (T13007): pushed with
 * `--force` over a head its device had not synced, or after taking another
 * device's live lease. Zero rows, so the server's count check is unaffected;
 * an annotation, never a table, so comparisons ignore it. Being on the signed
 * checkpoint, the label outlives the lease.
 */
export const VAULT_FORK_KEY = 'zz_vault_fork';

/**
 * The {@link VAULT_FORK_KEY} entry of a fork pushed over `overCheckpointId`.
 *
 * @param hashKey - The manifest hash key.
 * @param overCheckpointId - The head the fork was pushed over.
 * @returns The entry (0 rows; the hash binds it to that head).
 */
export function vaultForkEntry(hashKey: Uint8Array, overCheckpointId: string): VaultTableEntry {
  return {
    rows: 0,
    hash: crypto
      .createHmac('sha256', Buffer.from(hashKey))
      .update(`cleo-vault-fork/v1\n${overCheckpointId}\n`)
      .digest('hex'),
  };
}

/**
 * Whether a snapshot manifest carries the fork label.
 *
 * @param manifest - A checkpoint's manifest.
 * @returns `true` when {@link VAULT_FORK_KEY} is present.
 */
export function isVaultForkManifest(manifest: Pick<VaultManifest, 'tables'>): boolean {
  return Object.hasOwn(manifest.tables, VAULT_FORK_KEY);
}

/**
 * Compare two manifests table by table (union of both key sets, sorted). A
 * table one side does not list and the other lists with 0 rows is the same
 * (an emptied table stays listed on the cloud side); the fork label
 * ({@link VAULT_FORK_KEY}) is not a table and is left out.
 *
 * @param local - This side.
 * @param cloud - The other side.
 * @returns One line per table.
 */
export function compareVaultManifests(
  local: Pick<VaultManifest, 'tables'>,
  cloud: Pick<VaultManifest, 'tables'>,
): VaultTableComparison[] {
  const names = [...new Set([...Object.keys(local.tables), ...Object.keys(cloud.tables)])]
    .filter((table) => table !== VAULT_FORK_KEY)
    .sort();
  return names.map((table) => {
    const l = local.tables[table];
    const c = cloud.tables[table];
    const emptyVsAbsent = (l === undefined && c?.rows === 0) || (c === undefined && l?.rows === 0);
    return {
      table,
      localRows: l?.rows ?? null,
      cloudRows: c?.rows ?? null,
      match:
        emptyVsAbsent ||
        (l !== undefined && c !== undefined && l.rows === c.rows && l.hash === c.hash),
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

type Cell = string | number | bigint | null | Uint8Array;

function hasValue(v: unknown): boolean {
  return v !== null && v !== undefined && v !== '';
}

interface ColumnInfo {
  name: string;
  pk: number;
  type: string;
  notnull: number;
  dflt_value: string | null;
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
 *   credentials, machine-local paths) are copied from the live row with the
 *   same stable key. A table without one is skipped and reported; rows are
 *   never matched by an integer id, which each machine mints for itself.
 *   `strip` columns ({@link vaultStripColumns}) are not copied: they are NULL
 *   on every row, so this machine recomputes them against the restored data.
 * - Rows only the snapshot has (a project or skill on another machine only,
 *   a task this machine has not seen) never bring that machine's own values:
 *   every non-syncing cell (claims, leases, counters, paths) is cleared (NULL).
 *   A NOT NULL path outside `snapshotRoot` becomes a
 *   {@link VAULT_REMOTE_PATH_PREFIX} placeholder that is not a path and is
 *   never treated as an orphan; another NOT NULL cell takes its declared
 *   default, or stays when it has none. A path under `snapshotRoot` in a
 *   column the relocation rewrites stays (it becomes this machine's path).
 *
 * Syncing cells keep the snapshot's values (they are what the manifest
 * verified; non-syncing cells hash as NULL, so none of this changes the
 * manifest). A whole table is carried only when it has the same columns in
 * both stores; a column merge uses the columns both have. A live credential
 * that has nowhere to go is reported in `lost` with its re-entry remedy.
 *
 * @param stagedDbPath - The staged snapshot database (written in place).
 * @param liveDbPath - This machine's current database (read only), or `null` when it has none
 *   yet (a project restored onto this machine): every row is then a snapshot-only row.
 * @param scope - Which `cleo.db` this is.
 * @param opts - The snapshot's root (see {@link CarryMachineStateOptions}).
 * @returns What was carried, skipped, lost and scrubbed.
 */
export function carryMachineState(
  stagedDbPath: string,
  liveDbPath: string | null,
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
  // No store here yet (a project restored onto this machine): carry against an
  // empty one, so no local-only row and no non-syncing cell of the pusher's arrives.
  const live =
    liveDbPath === null
      ? new DatabaseSync(':memory:') // schema-guard-exempt: an empty in-memory stand-in for a store this machine does not have; only read
      : new DatabaseSync(liveDbPath, { readOnly: true });
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
    const absolute = (v: string) =>
      v.startsWith('/') || /^[A-Za-z]:[\\/]/.test(v) || v.startsWith('\\\\');
    // A path the restore relocates onto this machine: a relocatable column
    // under the snapshot's root (the relocation rewrites it).
    const relocatedHere = (v: Cell, relocatable: boolean) =>
      relocatable && typeof v === 'string' && absolute(v) && underSnapshotRoot(v);
    // An absolute path a restore will not relocate onto this machine.
    const foreignPath = (v: Cell, relocatable: boolean) =>
      typeof v === 'string' &&
      !isVaultRemotePath(v) &&
      absolute(v) &&
      !relocatedHere(v, relocatable);
    const stripped = vaultStripColumns(scope);
    staged.exec('PRAGMA foreign_keys = OFF');
    staged.exec('BEGIN IMMEDIATE');
    try {
      const carry = () => {
        for (const [t, sql] of [...tablesOf(staged)].sort(([a], [b]) =>
          a < b ? -1 : a > b ? 1 : 0,
        )) {
          // The trigger-suspension flags are transient machinery the carry itself
          // holds: carrying the live (empty) table would lift its own suspension.
          if (t === TRIGGER_SUSPEND_TABLE) continue;
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
          // A table this store lacks matches no live row; its key still names placeholders.
          const stable = stableKey(
            staged,
            t,
            sql,
            stagedInfo,
            liveTables.has(t) ? common : new Set(stagedCols),
          );
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
            // A `strip` column is recomputed here, never carried (T13022).
            const merge =
              c.class === 'portable-secret'
                ? [...common].filter((n) => !key.includes(n) && !unstablePk.includes(n))
                : local.filter((n) => common.has(n) && !(stripped[t] ?? []).includes(n));
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
            const insert =
              cols.length > 0
                ? staged.prepare(
                    `INSERT INTO ${quoteIdent(t)} (${cols.map(quoteIdent).join(', ')}) VALUES (${cols.map(() => '?').join(', ')})`,
                  )
                : null;
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
                } else if (c.class === 'portable-secret' && insert !== null) {
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

          // `strip` columns (a derived pointer such as `tree_id`, a git remote URL)
          // are NULL on every row, so this machine recomputes them (T13022).
          const nullable = new Set(stagedInfo.filter((x) => x.notnull !== 1).map((x) => x.name));
          for (const col of (stripped[t] ?? []).filter((n) => nullable.has(n))) {
            staged
              .prepare(
                `UPDATE ${quoteIdent(t)} SET ${quoteIdent(col)} = NULL WHERE ${quoteIdent(col)} IS NOT NULL`,
              )
              .run();
          }

          // Rows only the snapshot has never bring another machine's own values.
          if (c.class === 'portable-secret') continue;
          if (local.length === 0 || /WITHOUT ROWID/i.test(sql)) continue;
          const info = new Map(stagedInfo.map((x) => [x.name, x]));
          const scrubKey = stable?.key ?? null;
          let scrubbed = 0;
          const select = staged.prepare(`SELECT rowid AS rid, * FROM ${quoteIdent(t)}`);
          select.setReadBigInts(true);
          for (const r of select.all() as Array<Record<string, Cell>>) {
            const k = scrubKey === null ? null : keyOf(r, scrubKey);
            if (k !== null && liveKeys.has(k)) continue;
            const sets: string[] = [];
            const values: Cell[] = [];
            const defaults: string[] = [];
            for (const col of local) {
              const v = r[col] ?? null;
              if (!hasValue(v) || isVaultRemotePath(typeof v === 'string' ? v : null)) continue;
              const relocatable = relocatableColumn(t, col, false) === 'path';
              if (relocatedHere(v, relocatable)) continue;
              const column = info.get(col);
              if (column?.notnull !== 1) {
                // Another machine's claim, lease, counter or path (T13007 N5): NULL here.
                sets.push(`${quoteIdent(col)} = NULL`);
              } else if (foreignPath(v, relocatable)) {
                // A NOT NULL path: a placeholder that is not a path and never an orphan.
                sets.push(`${quoteIdent(col)} = ?`);
                values.push(`${VAULT_REMOTE_PATH_PREFIX}${t}:${k ?? String(r['rid'])}:${col}`);
              } else if (column.dflt_value !== null) {
                // A NOT NULL value with a declared default: the default (the schema's own text).
                defaults.push(`${quoteIdent(col)} = ${column.dflt_value}`);
              }
            }
            if (sets.length + defaults.length === 0) continue;
            const scrub = (assignments: readonly string[]) =>
              staged
                .prepare(`UPDATE ${quoteIdent(t)} SET ${assignments.join(', ')} WHERE rowid = ?`)
                .run(...values, r['rid'] ?? null);
            try {
              scrub([...sets, ...defaults]);
            } catch (err) {
              // A default another row already holds under a UNIQUE index: that value stays.
              if (sets.length === 0) continue;
              if (defaults.length === 0) throw err;
              scrub(sets);
            }
            scrubbed += 1;
          }
          if (scrubbed > 0) out.scrubbed.push({ table: t, rows: scrubbed });
        }
      };
      // Carrying this machine's values is not a change to capture, and no
      // side-effect trigger may act on it (journal S2, T12819); guards stay on.
      if (hasTriggerSuspendTable(staged)) {
        withTriggersSuspended(staged, ['capture', 'side-effect'], 'forward', carry);
      } else {
        carry();
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
