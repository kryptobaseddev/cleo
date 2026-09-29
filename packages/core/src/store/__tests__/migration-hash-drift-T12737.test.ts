/**
 * T12737 — reconcileJournal no longer silently re-journals a post-consolidation
 * migration whose SQL changed after the store applied it.
 *
 * Incident: successive pre-release builds of t12502 each shipped a different
 * `migration.sql`. Scenario 2 Sub-case B deleted the older-hash row as an
 * orphan, and Scenario 3 Case A re-stamped the new hash because every column
 * existed — without running the CHECKs and index the new version added.
 *
 * Pinned here:
 *  - a same-name, different-hash row of a POST-cutover migration throws
 *    `E_MIGRATION_HASH_DRIFT` and leaves the journal untouched;
 *  - the explicit opt-in keeps the old delete-and-re-probe path;
 *  - a PRE-cutover drift (released history, e.g. t033) is still reconciled —
 *    see migration-hash-drift.test.ts;
 *  - Case A / Case B stamps log at ERROR level.
 *
 * @task T12737
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { readMigrationFiles } from 'drizzle-orm/migrator';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const logged = vi.hoisted(() => ({ error: [] as string[], warn: [] as string[] }));

vi.mock('../../logger.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../logger.js')>();
  const record =
    (sink: string[]) =>
    (_obj: unknown, msg?: string): void => {
      sink.push(String(msg ?? ''));
    };
  const logger = {
    trace: vi.fn(),
    debug: vi.fn(),
    info: vi.fn(),
    warn: record(logged.warn),
    error: record(logged.error),
    fatal: vi.fn(),
    child: () => logger,
  };
  return { ...actual, getLogger: () => logger };
});

const {
  ALLOW_MIGRATION_HASH_DRIFT_ENV,
  E_MIGRATION_HASH_DRIFT,
  findPostCutoverHashDrift,
  MigrationHashDriftError,
  reconcileJournal,
} = await import('../migration-manager.js');

const BASE = '20260901000000_base';
const LEASES = '20260929120000_leases';
const STALE_HASH = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';

let tempDir: string;
let savedOptIn: string | undefined;

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), 'cleo-hash-drift-T12737-'));
  logged.error.length = 0;
  logged.warn.length = 0;
  savedOptIn = process.env[ALLOW_MIGRATION_HASH_DRIFT_ENV];
  delete process.env[ALLOW_MIGRATION_HASH_DRIFT_ENV];
});

afterEach(() => {
  if (savedOptIn === undefined) delete process.env[ALLOW_MIGRATION_HASH_DRIFT_ENV];
  else process.env[ALLOW_MIGRATION_HASH_DRIFT_ENV] = savedOptIn;
  rmSync(tempDir, { recursive: true, force: true });
});

/** A migration lineage in drizzle's `<ts>_<name>/migration.sql` layout. */
function lineage(migrations: Array<[string, string]>): string {
  const dir = join(tempDir, 'migrations');
  for (const [name, sql] of migrations) {
    mkdirSync(join(dir, name), { recursive: true });
    writeFileSync(join(dir, name, 'migration.sql'), sql);
  }
  return dir;
}

/** A store with table `t` (and `extraDdl`) whose journal holds `rows`. */
function store(extraDdl: string, rows: Array<{ hash: string; millis: number; name: string }>) {
  const db = new DatabaseSync(join(tempDir, 'cleo.db'));
  db.exec(`CREATE TABLE t (id INTEGER PRIMARY KEY${extraDdl});`);
  db.exec(`CREATE TABLE "__drizzle_migrations" (
    id INTEGER PRIMARY KEY AUTOINCREMENT, hash text NOT NULL, created_at numeric, name text, applied_at TEXT
  )`);
  const insert = db.prepare(
    'INSERT INTO "__drizzle_migrations" (hash, created_at, name) VALUES (?, ?, ?)',
  );
  for (const r of rows) insert.run(r.hash, r.millis, r.name);
  return db;
}

function journal(db: DatabaseSync): Array<{ hash: string; name: string }> {
  return db.prepare('SELECT hash, name FROM "__drizzle_migrations" ORDER BY id').all() as Array<{
    hash: string;
    name: string;
  }>;
}

describe('T12737 — post-cutover hash drift is refused, not re-stamped', () => {
  function driftedStore(): { db: DatabaseSync; folder: string; leasesHash: string } {
    const folder = lineage([
      [BASE, 'CREATE TABLE `t` (`id` integer PRIMARY KEY);'],
      [
        LEASES,
        'ALTER TABLE `t` ADD COLUMN `claimed_at` TEXT CHECK ("claimed_at" IS NULL OR "claimed_at" GLOB \'[0-9]*\');\n--> statement-breakpoint\nCREATE INDEX IF NOT EXISTS `idx_t_claimed_at` ON `t` (`claimed_at`);',
      ],
    ]);
    const [base, leases] = readMigrationFiles({ migrationsFolder: folder });
    // The store ran a pre-release version of LEASES: the column exists without
    // its CHECK and index, and the journal row carries that version's hash.
    const db = store(', claimed_at TEXT', [
      { hash: base!.hash, millis: base!.folderMillis, name: BASE },
      { hash: STALE_HASH, millis: leases!.folderMillis, name: LEASES },
    ]);
    return { db, folder, leasesHash: leases!.hash };
  }

  it('throws E_MIGRATION_HASH_DRIFT naming the migration and both hashes; journal untouched', () => {
    const { db, folder, leasesHash } = driftedStore();
    const before = journal(db);
    let caught: unknown;
    try {
      reconcileJournal(db, folder, 't', 'test');
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(MigrationHashDriftError);
    const error = caught as InstanceType<typeof MigrationHashDriftError>;
    expect(error.message).toContain(E_MIGRATION_HASH_DRIFT);
    expect(error.message).toContain(LEASES);
    expect(error.message).toContain(STALE_HASH.slice(0, 12));
    expect(error.message).toContain(leasesHash.slice(0, 12));
    expect(error.fix).toContain(ALLOW_MIGRATION_HASH_DRIFT_ENV);
    expect(error.drift).toEqual([{ name: LEASES, journalHash: STALE_HASH, localHash: leasesHash }]);
    expect(journal(db)).toEqual(before);
    db.close();
  });

  it('with the opt-in, keeps the old delete-and-re-probe path and logs it at error level', () => {
    const { db, folder, leasesHash } = driftedStore();
    process.env[ALLOW_MIGRATION_HASH_DRIFT_ENV] = '1';
    reconcileJournal(db, folder, 't', 'test');
    const hashes = journal(db).map((r) => r.hash);
    expect(hashes).not.toContain(STALE_HASH);
    // Case A stamps the new hash (the column exists) — at error level.
    expect(hashes).toContain(leasesHash);
    expect(logged.error.some((m) => m.includes(E_MIGRATION_HASH_DRIFT))).toBe(true);
    expect(logged.error.some((m) => m.includes('WITHOUT running its SQL'))).toBe(true);
    db.close();
  });

  it('a true orphan (name unknown to this install) is still deleted', () => {
    const folder = lineage([[BASE, 'CREATE TABLE `t` (`id` integer PRIMARY KEY);']]);
    const [base] = readMigrationFiles({ migrationsFolder: folder });
    const db = store('', [
      { hash: STALE_HASH, millis: 1, name: '20260101000000_removed' },
      { hash: 'b'.repeat(64), millis: base!.folderMillis, name: '20260902000000_other' },
    ]);
    reconcileJournal(db, folder, 't', 'test');
    const hashes = journal(db).map((r) => r.hash);
    expect(hashes).not.toContain(STALE_HASH);
    expect(hashes).toContain(base!.hash);
    db.close();
  });

  it('findPostCutoverHashDrift ignores pre-cutover names, matching hashes and null names', () => {
    const local = [
      { name: '20260321000000_t033-connection-health', hash: 'new033' },
      { name: LEASES, hash: 'newLeases' },
    ];
    const cutover = '20260531000001';
    expect(
      findPostCutoverHashDrift(
        [
          { name: '20260321000000_t033-connection-health', hash: 'old033' },
          { name: LEASES, hash: 'newLeases' },
          { name: null, hash: 'x' },
        ],
        local,
        cutover,
      ),
    ).toEqual([]);
    expect(findPostCutoverHashDrift([{ name: LEASES, hash: 'old' }], local, cutover)).toEqual([
      { name: LEASES, journalHash: 'old', localHash: 'newLeases' },
    ]);
  });
});

describe('T12737 — Case A / Case B stamps log at error level', () => {
  it('Case A (every column exists) stamps and logs an error', () => {
    const folder = lineage([
      [BASE, 'CREATE TABLE `t` (`id` integer PRIMARY KEY);'],
      [LEASES, 'ALTER TABLE `t` ADD COLUMN `a` TEXT;'],
    ]);
    const [base, leases] = readMigrationFiles({ migrationsFolder: folder });
    const db = store(', a TEXT', [{ hash: base!.hash, millis: base!.folderMillis, name: BASE }]);
    reconcileJournal(db, folder, 't', 'test');
    expect(journal(db).map((r) => r.hash)).toContain(leases!.hash);
    expect(logged.error.some((m) => m.includes(LEASES) && m.includes('WITHOUT running'))).toBe(
      true,
    );
    db.close();
  });

  it('Case B (some columns exist) adds the missing ones, stamps and logs an error', () => {
    const folder = lineage([
      [BASE, 'CREATE TABLE `t` (`id` integer PRIMARY KEY);'],
      [
        LEASES,
        'ALTER TABLE `t` ADD COLUMN `a` TEXT;\n--> statement-breakpoint\nALTER TABLE `t` ADD COLUMN `b` TEXT;',
      ],
    ]);
    const [base, leases] = readMigrationFiles({ migrationsFolder: folder });
    const db = store(', a TEXT', [{ hash: base!.hash, millis: base!.folderMillis, name: BASE }]);
    reconcileJournal(db, folder, 't', 'test');
    expect(journal(db).map((r) => r.hash)).toContain(leases!.hash);
    const cols = (db.prepare('PRAGMA table_info(t)').all() as Array<{ name: string }>).map(
      (c) => c.name,
    );
    expect(cols).toContain('b');
    expect(logged.error.some((m) => m.includes(LEASES) && m.includes('WITHOUT running'))).toBe(
      true,
    );
    db.close();
  });
});
