/**
 * `projectStoreAheadOfBuild` — the read-only journal check behind the census's
 * foreign-store preflight (T14440, census AC3).
 *
 * A store whose `__drizzle_migrations` journal holds a row hash no installed
 * lineage defines was written by a newer (unreleased) build; opening it with
 * this binary is the hazard the census must avoid. Real SQLite files, real
 * hashing; nothing is written.
 *
 * @task T14440
 */

import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { resolveCorePackageMigrationsFolder } from '../../store/resolve-migrations-folder.js';
import { projectStoreAheadOfBuild } from '../migrations.js';

let base: string;
let projectRoot: string;
let prevCleoDir: string | undefined;

/** A project store holding a journal with the given row hashes. */
function storeWithJournal(hashes: string[]): string {
  const dbPath = join(projectRoot, '.cleo', 'cleo.db');
  mkdirSync(join(projectRoot, '.cleo'), { recursive: true });
  const db = new DatabaseSync(dbPath);
  db.exec('CREATE TABLE __drizzle_migrations (id INTEGER PRIMARY KEY, hash TEXT)');
  for (const hash of hashes) {
    db.prepare('INSERT INTO __drizzle_migrations (hash) VALUES (?)').run(hash);
  }
  db.close();
  return dbPath;
}

/** The sha256 hash drizzle's readMigrationFiles computes for one migration. */
function installedMigrationHash(): string {
  const folder = resolveCorePackageMigrationsFolder('drizzle-cleo-project');
  const first = readdirSync(folder).sort()[0];
  if (first === undefined) throw new Error('no installed project migrations');
  return createHash('sha256')
    .update(readFileSync(join(folder, first, 'migration.sql')).toString())
    .digest('hex');
}

beforeEach(() => {
  base = mkdtempSync(join(tmpdir(), 'store-ahead-'));
  projectRoot = join(base, 'proj');
  mkdirSync(projectRoot, { recursive: true });
  // The store resolver walks ancestors for a `.cleo/` dir, bounded by $HOME —
  // a tmpdir outside it resolves unpredictably. CLEO_DIR pins the store path
  // to the fixture, exactly what a real registered project resolves to.
  prevCleoDir = process.env['CLEO_DIR'];
  process.env['CLEO_DIR'] = join(projectRoot, '.cleo');
});

afterEach(() => {
  if (prevCleoDir === undefined) delete process.env['CLEO_DIR'];
  else process.env['CLEO_DIR'] = prevCleoDir;
  rmSync(base, { recursive: true, force: true });
});

describe('projectStoreAheadOfBuild (T14440)', () => {
  it('a missing store is ok: there is nothing ahead of this build', () => {
    expect(projectStoreAheadOfBuild(projectRoot)).toBe('ok');
  });

  it('a journal of installed migrations only is ok', () => {
    storeWithJournal([installedMigrationHash()]);
    expect(projectStoreAheadOfBuild(projectRoot)).toBe('ok');
  });

  it('a journal row no installed lineage defines is ahead (a newer build wrote it)', () => {
    storeWithJournal([installedMigrationHash(), 'b'.repeat(64)]);
    expect(projectStoreAheadOfBuild(projectRoot)).toBe('ahead');
  });

  it('a file that is not a valid store is unreadable, never ahead', () => {
    const dbPath = join(projectRoot, '.cleo', 'cleo.db');
    mkdirSync(join(projectRoot, '.cleo'), { recursive: true });
    writeFileSync(dbPath, 'this is not sqlite');
    expect(projectStoreAheadOfBuild(projectRoot)).toBe('unreadable');
  });
});
