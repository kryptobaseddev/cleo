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
 * - Credential columns ({@link CREDENTIAL_COLUMNS}) hash as NULL: an
 *   unencrypted bundle clears them, so the live store and its snapshot must
 *   agree without them.
 *
 * @task T12336
 * @epic T12322
 */

import crypto from 'node:crypto';
import { createRequire } from 'node:module';
import type { DatabaseSync as _DatabaseSyncType } from 'node:sqlite';
import type { TableScope } from '@cleocode/contracts';
import { relocatableColumn, relocateCell } from './portable-bundle-relocate.js';
import { CREDENTIAL_COLUMNS } from './portable-bundle-scan.js';
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

/** Options for {@link buildVaultManifest}. */
export interface BuildVaultManifestOptions {
  /** Which `cleo.db` this is (decides the table classes). */
  scope: TableScope;
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
      const names = all.filter((t) => !isVirtual(t) && isVaultManifestTable(opts.scope, t.name));
      for (const { name, sql } of names) {
        if (!MANIFEST_KEY.test(name)) {
          skipped.push(name);
          continue;
        }
        const digests: Buffer[] = [];
        const cleared = new Set(CREDENTIAL_COLUMNS[name] ?? []);
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

/** What {@link preserveLocalTables} carried over. */
export interface PreservedLocalTables {
  /** Tables whose rows now come from the live store. */
  preserved: string[];
  /** Local-only tables left as the snapshot had them (absent or shaped differently here). */
  skipped: string[];
}

/**
 * Before a vault restore activates a snapshot, carry this machine's
 * `local-only` rows into the staged copy: the replica binding, the project
 * registry's paths and other machine state belong to this machine, not to
 * the device that pushed the snapshot. Syncing tables keep the snapshot's
 * rows (they are what the manifest verified); derived tables are rebuilt
 * from them.
 *
 * A table is carried over only when it exists in both stores with the same
 * columns in the same order; otherwise the snapshot's rows are kept and the
 * table is reported as skipped.
 *
 * @param stagedDbPath - The staged snapshot database (written in place).
 * @param liveDbPath - This machine's current database (read only).
 * @param scope - Which `cleo.db` this is.
 * @returns The tables carried over and those skipped.
 */
export function preserveLocalTables(
  stagedDbPath: string,
  liveDbPath: string,
  scope: TableScope,
): PreservedLocalTables {
  const out: PreservedLocalTables = { preserved: [], skipped: [] };
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
    const columnsOf = (db: DatabaseSync, t: string) =>
      (db.prepare(`PRAGMA table_info(${quoteIdent(t)})`).all() as Array<{ name: string }>)
        .map((c) => c.name)
        .join('\u0000');
    const liveTables = tablesOf(live);
    const local = [...tablesOf(staged)]
      .filter((t) => {
        const c = classifyTable(scope, t);
        return (c.kind === 'entry' || c.kind === 'pattern') && c.class === 'local-only';
      })
      .sort();
    staged.exec('PRAGMA foreign_keys = OFF');
    staged.exec('BEGIN IMMEDIATE');
    try {
      for (const t of local) {
        if (!liveTables.has(t) || columnsOf(live, t) !== columnsOf(staged, t)) {
          out.skipped.push(t);
          continue;
        }
        const cols = (
          live.prepare(`PRAGMA table_info(${quoteIdent(t)})`).all() as Array<{
            name: string;
          }>
        ).map((c) => c.name);
        const select = live.prepare(`SELECT * FROM ${quoteIdent(t)}`);
        select.setReadBigInts(true);
        const rows = select.all() as Array<Record<string, unknown>>;
        // gate-28: local-only table, restored onto a staged snapshot before activation
        staged.prepare(`DELETE FROM ${quoteIdent(t)}`).run();
        if (rows.length > 0) {
          const insert = staged.prepare(
            `INSERT INTO ${quoteIdent(t)} (${cols.map(quoteIdent).join(', ')}) VALUES (${cols.map(() => '?').join(', ')})`,
          );
          for (const row of rows) {
            insert.run(
              ...(cols.map((c) => row[c]) as Array<string | number | bigint | null | Uint8Array>),
            );
          }
        }
        out.preserved.push(t);
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
