/**
 * `projectStoreReadVerdict` — the read-only journal verdict behind the
 * census's foreign-store preflight (T14440, census AC3).
 *
 * A store the enrichment must NOT open (missing, no journal, written by a
 * newer build, behind this build, unreadable) gets a `not read: <reason>`
 * verdict; only a fully-known, fully-applied journal is `readable`. Real
 * SQLite files, real hashing; nothing is written.
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
import { PROJECT_LINEAGES, projectStoreReadVerdict } from '../migrations.js';

let base: string;
let projectRoot: string;
let prevCleoDir: string | undefined;

function sha256File(path: string): string {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

/** A project store holding a journal with the given row hashes. */
function storeWithJournal(hashes: string[]): { dbPath: string; sha: string } {
  const dbPath = join(projectRoot, '.cleo', 'cleo.db');
  mkdirSync(join(projectRoot, '.cleo'), { recursive: true });
  const db = new DatabaseSync(dbPath);
  db.exec('CREATE TABLE __drizzle_migrations (id INTEGER PRIMARY KEY, hash TEXT)');
  for (const hash of hashes) {
    db.prepare('INSERT INTO __drizzle_migrations (hash) VALUES (?)').run(hash);
  }
  db.close();
  return { dbPath, sha: sha256File(dbPath) };
}

/** Every hash the project-scope lineages install, as drizzle hashes them. */
function allProjectLineageHashes(): string[] {
  const out: string[] = [];
  for (const lineage of PROJECT_LINEAGES) {
    const folder = resolveCorePackageMigrationsFolder(lineage);
    for (const dir of readdirSync(folder).sort()) {
      out.push(
        createHash('sha256')
          .update(readFileSync(join(folder, dir, 'migration.sql')).toString())
          .digest('hex'),
      );
    }
  }
  return out;
}

/** One installed project migration's hash (an "old floor" journal). */
function oneInstalledHash(): string {
  const folder = resolveCorePackageMigrationsFolder('drizzle-cleo-project');
  const first = readdirSync(folder).sort()[0];
  if (first === undefined) throw new Error('no installed project migrations');
  return createHash('sha256')
    .update(readFileSync(join(folder, first, 'migration.sql')).toString())
    .digest('hex');
}

beforeEach(() => {
  base = mkdtempSync(join(tmpdir(), 'store-verdict-'));
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

describe('projectStoreReadVerdict (T14440 AC3)', () => {
  it('a missing store is not read', () => {
    expect(projectStoreReadVerdict(projectRoot)).toBe('not read: missing store');
  });

  it('a journal at an old floor (pending migrations) is not read: opening it would migrate', () => {
    const { dbPath, sha } = storeWithJournal([oneInstalledHash()]);
    expect(projectStoreReadVerdict(projectRoot)).toBe(
      'not read: store behind this build (pending migrations)',
    );
    // The verdict is read-only: the fixture store is byte-identical after.
    expect(sha256File(dbPath)).toBe(sha);
  });

  it('a journal row no installed lineage defines is not read (a newer build wrote it)', () => {
    storeWithJournal([oneInstalledHash(), 'b'.repeat(64)]);
    expect(projectStoreReadVerdict(projectRoot)).toBe('not read: store written by a newer build');
  });

  it('a fully-known, fully-applied journal is readable', () => {
    storeWithJournal(allProjectLineageHashes());
    expect(projectStoreReadVerdict(projectRoot)).toBe('readable');
  });

  it('a file that is not a valid store is not read, never ahead', () => {
    const dbPath = join(projectRoot, '.cleo', 'cleo.db');
    mkdirSync(join(projectRoot, '.cleo'), { recursive: true });
    writeFileSync(dbPath, 'this is not sqlite');
    expect(projectStoreReadVerdict(projectRoot)).toBe('not read: unreadable store');
  });
});
