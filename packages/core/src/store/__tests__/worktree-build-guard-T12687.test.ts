/**
 * T12687 — a worktree-built CLI never migrates a store outside its worktree,
 * and an older build never deletes a newer build's journal rows.
 *
 * Incident 2026-09-29: cleo-nexus's slice-2 build (inside a linked worktree)
 * wrote `__drizzle_migrations` row 114 into the LIVE cleocode store; the
 * released CLI then deleted the unknown row as an orphan and the next slice-2
 * open re-ran `ADD COLUMN` and failed.
 *
 * Everything here runs on scratch repos and scratch stores in the sandbox.
 *
 * @task T12687
 */

import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { drizzle } from 'drizzle-orm/node-sqlite';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { migrateSanitized, reconcileJournal } from '../migration-manager.js';
import {
  ALLOW_WORKTREE_BUILD_MIGRATIONS_ENV,
  setWorktreeBuildGuardForTests,
  worktreeBuildMigrationRefusal,
} from '../worktree-build-guard.js';

const roots: string[] = [];

function git(cwd: string, ...args: string[]): void {
  execFileSync('git', args, { cwd, stdio: 'ignore' });
}

/** A main checkout with a store, plus a linked worktree holding a "build". */
function scratchRepos(): { main: string; worktree: string; store: string; build: string } {
  const tmp = realpathSync(mkdtempSync(join(tmpdir(), 'cleo-t12687-')));
  roots.push(tmp);
  const main = join(tmp, 'main');
  mkdirSync(join(main, '.cleo'), { recursive: true });
  writeFileSync(join(main, 'README.md'), 'x\n');
  git(main, 'init', '-b', 'main');
  git(main, 'add', 'README.md');
  git(
    main,
    '-c',
    'user.email=t@example.test',
    '-c',
    'user.name=T',
    '-c',
    'commit.gpgsign=false',
    'commit',
    '--no-verify',
    '-m',
    'init',
  );
  const worktree = join(tmp, 'wt');
  git(main, 'worktree', 'add', '-b', 'slice-2', worktree, 'main');
  const build = join(worktree, 'packages', 'core', 'dist', 'store', 'migration-manager.js');
  mkdirSync(join(build, '..'), { recursive: true });
  writeFileSync(build, '');
  return { main, worktree, store: join(main, '.cleo', 'cleo.db'), build };
}

/** A migration lineage folder in drizzle's `<ts>_<name>/migration.sql` layout. */
function lineage(dir: string, migrations: Array<[string, string]>): string {
  for (const [name, sql] of migrations) {
    mkdirSync(join(dir, name), { recursive: true });
    writeFileSync(join(dir, name, 'migration.sql'), sql);
  }
  return dir;
}

const BASE: [string, string] = [
  '20260901000000_base',
  'CREATE TABLE `t` (`id` integer PRIMARY KEY);',
];
const SLICE2: [string, string] = [
  '20260929000000_slice-2-union-shape',
  'ALTER TABLE `t` ADD COLUMN `shape` text;',
];

function journal(store: string): Array<{ hash: string; created_at: number }> {
  const db = new DatabaseSync(store, { readOnly: true });
  try {
    return db
      .prepare('SELECT hash, created_at FROM "__drizzle_migrations" ORDER BY id')
      .all() as Array<{ hash: string; created_at: number }>;
  } finally {
    db.close();
  }
}

function columns(store: string): string[] {
  const db = new DatabaseSync(store, { readOnly: true });
  try {
    return (db.prepare('PRAGMA table_info(t)').all() as Array<{ name: string }>).map((c) => c.name);
  } finally {
    db.close();
  }
}

/** Open, reconcile and migrate one lineage the way every store open does. */
function openAndMigrate(store: string, folder: string): void {
  const native = new DatabaseSync(store);
  try {
    reconcileJournal(native, folder, 't', 'test');
    migrateSanitized(drizzle({ client: native }), { migrationsFolder: folder });
  } finally {
    native.close();
  }
}

afterEach(() => {
  setWorktreeBuildGuardForTests(null);
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  for (const dir of roots.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe('T12687 — worktreeBuildMigrationRefusal', () => {
  it('refuses a worktree build migrating a store outside the worktree, naming both paths', () => {
    const r = scratchRepos();
    const refusal = worktreeBuildMigrationRefusal(r.store, { codePath: r.build, tmpRoots: [] });
    expect(refusal).toContain(`Refusing to migrate ${r.store}`);
    expect(refusal).toContain(`built inside the git worktree ${r.worktree}`);
    expect(refusal).toContain(ALLOW_WORKTREE_BUILD_MIGRATIONS_ENV);
  });

  it('allows: installed builds, main-checkout builds, own-worktree stores, scratch stores, opt-in', () => {
    const r = scratchRepos();
    const opts = { codePath: r.build, tmpRoots: [] as string[] };
    const installed = join(r.worktree, 'node_modules', '@cleocode', 'core', 'dist', 'x.js');
    expect(worktreeBuildMigrationRefusal(r.store, { ...opts, codePath: installed })).toBeNull();
    expect(
      worktreeBuildMigrationRefusal(r.store, { ...opts, codePath: join(r.main, 'dist', 'x.js') }),
    ).toBeNull();
    expect(worktreeBuildMigrationRefusal(join(r.worktree, '.cleo', 'cleo.db'), opts)).toBeNull();
    expect(worktreeBuildMigrationRefusal(r.store, { codePath: r.build })).toBeNull(); // under tmp
    expect(
      worktreeBuildMigrationRefusal(r.store, {
        ...opts,
        env: { [ALLOW_WORKTREE_BUILD_MIGRATIONS_ENV]: '1' },
      }),
    ).toBeNull();
  });
});

describe('T12687 — a worktree build leaves the main store journal unchanged', () => {
  it('skips reconcile + migrate for pending migrations, but still lets the store open', () => {
    const r = scratchRepos();
    const released = lineage(join(r.main, '..', 'released'), [BASE]);
    const worktreeBuild = lineage(join(r.worktree, 'migrations'), [BASE, SLICE2]);

    openAndMigrate(r.store, released); // the released CLI built the store
    const before = journal(r.store);
    expect(before).toHaveLength(1);

    setWorktreeBuildGuardForTests({ codePath: r.build, tmpRoots: [] });
    const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    openAndMigrate(r.store, worktreeBuild);

    expect(journal(r.store)).toEqual(before);
    expect(columns(r.store)).toEqual(['id']);
    expect(stderr.mock.calls.map(([line]) => String(line)).join('')).toContain(
      `Refusing to migrate ${r.store}`,
    );

    // With the explicit opt-in the same build migrates.
    vi.stubEnv(ALLOW_WORKTREE_BUILD_MIGRATIONS_ENV, '1');
    openAndMigrate(r.store, worktreeBuild);
    expect(journal(r.store)).toHaveLength(2);
    expect(columns(r.store)).toEqual(['id', 'shape']);
  });
});

describe('T12687 — an older build preserves a newer build journal row', () => {
  it('keeps rows stamped after every migration it knows; still prunes true (older) orphans', () => {
    const r = scratchRepos();
    const newer = lineage(join(r.main, '..', 'newer'), [BASE, SLICE2]);
    openAndMigrate(r.store, newer); // a newer build applied slice-2
    // A true orphan: an unknown row OLDER than everything the old build knows.
    const db = new DatabaseSync(r.store);
    db.prepare('INSERT INTO "__drizzle_migrations" (hash, created_at, name) VALUES (?, ?, ?)').run(
      'dead-hash',
      Date.UTC(2020, 0, 1),
      '20200101000000_removed',
    );
    db.close();

    // The older build knows BASE plus a migration of its own not yet applied,
    // which is what sends reconcileJournal into orphan deletion (Sub-case B).
    const older = lineage(join(r.main, '..', 'older'), [
      BASE,
      ['20260915000000_older-only', 'CREATE TABLE IF NOT EXISTS `u` (`id` integer PRIMARY KEY);'],
    ]);
    const slice2Row = journal(r.store).find(
      (row) => Number(row.created_at) === Date.UTC(2026, 8, 29),
    );
    expect(slice2Row).toBeDefined();

    openAndMigrate(r.store, older);
    const after = journal(r.store).map((row) => row.hash);
    expect(after).toContain(slice2Row!.hash);
    expect(after).not.toContain('dead-hash');
  });
});
