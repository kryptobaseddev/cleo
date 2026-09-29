/**
 * T12687 — a worktree build never changes the schema of a store outside its
 * worktree, and an older build never deletes a newer build's journal rows.
 *
 * Incident 2026-09-29: cleo-nexus's slice-2 build (inside a linked worktree)
 * wrote `__drizzle_migrations` row 114 into the LIVE cleocode store; the
 * released CLI then deleted the unknown row as an orphan and the next slice-2
 * open re-ran `ADD COLUMN` and failed.
 *
 * Everything here runs on scratch repos and scratch stores. The test harness
 * itself is exempt (`VITEST`), so each case describes the build it simulates
 * through `setWorktreeBuildGuardForTests` with an explicit, VITEST-free `env`.
 *
 * @task T12687
 */

import { execFileSync } from 'node:child_process';
import {
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';
import { drizzle } from 'drizzle-orm/node-sqlite';
import { afterEach, describe, expect, it } from 'vitest';
import { _resetDualScopeDbCache, openDualScopeDbAtPath } from '../dual-scope-db.js';
import { ensureColumns, migrateSanitized, reconcileJournal } from '../migration-manager.js';
import {
  ALLOW_WORKTREE_BUILD_MIGRATIONS_ENV,
  devBuildWorktree,
  E_WORKTREE_BUILD_SCHEMA,
  installSchemaWriteGuard,
  readBuildProvenance,
  refreshSchemaWriteGuard,
  schemaWriteRefusal,
  setWorktreeBuildGuardForTests,
  TEST_SANDBOX_MARKER,
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

/** Simulate running as the worktree build, outside the test harness. */
function asWorktreeBuild(build: string, env: NodeJS.ProcessEnv = {}): void {
  setWorktreeBuildGuardForTests({
    codePath: build,
    provenance: null,
    env,
    honourTestSandbox: false,
  });
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

function columns(store: string, table = 't'): string[] {
  const db = new DatabaseSync(store, { readOnly: true });
  try {
    return (db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>).map(
      (c) => c.name,
    );
  } finally {
    db.close();
  }
}

/** Open, guard, reconcile and migrate one lineage the way every store open does. */
function openAndMigrate(store: string, folder: string): void {
  const native = new DatabaseSync(store);
  try {
    installSchemaWriteGuard(native);
    reconcileJournal(native, folder, 't', 'test');
    migrateSanitized(drizzle({ client: native }), { migrationsFolder: folder });
  } finally {
    native.close();
  }
}

afterEach(() => {
  setWorktreeBuildGuardForTests(null);
  _resetDualScopeDbCache();
  for (const dir of roots.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe('T12687 — who may change a store schema', () => {
  it('refuses a worktree build on a store outside its worktree, naming both paths and the opt-in', () => {
    const r = scratchRepos();
    const refusal = schemaWriteRefusal(r.store, {
      codePath: r.build,
      provenance: null,
      env: {},
      honourTestSandbox: false,
    });
    expect(refusal).toContain(`Refusing to change the schema of ${r.store}`);
    expect(refusal).toContain(`built inside the git worktree ${r.worktree}`);
    expect(refusal).toContain(ALLOW_WORKTREE_BUILD_MIGRATIONS_ENV);
  });

  it('a project store under the temp dir is a real store: no temp exemption outside the harness', () => {
    const r = scratchRepos(); // the whole fixture lives under the temp dir
    expect(
      schemaWriteRefusal(r.store, {
        codePath: r.build,
        provenance: null,
        env: {},
        honourTestSandbox: false,
      }),
    ).not.toBeNull();
  });

  it('the build stamp travels: an npm-packed worktree build under node_modules is refused', () => {
    const r = scratchRepos();
    const installed = join(r.main, 'node_modules', '@cleocode', 'core', 'dist', 'store', 'x.js');
    expect(
      schemaWriteRefusal(r.store, {
        codePath: installed,
        provenance: { linkedWorktree: r.worktree },
        env: {},
        honourTestSandbox: false,
      }),
    ).toContain(`built inside the git worktree ${r.worktree}`);
    // A dist copied outside any checkout, stamped with its worktree, is refused too.
    expect(
      schemaWriteRefusal(r.store, {
        codePath: join(tmpdir(), 'copied', 'dist', 'x.js'),
        provenance: { linkedWorktree: r.worktree },
        env: {},
        honourTestSandbox: false,
      }),
    ).not.toBeNull();
  });

  it('allows released builds, own-worktree stores, the test harness and the explicit opt-in', () => {
    const r = scratchRepos();
    const base = { codePath: r.build, provenance: null, env: {}, honourTestSandbox: false };
    const installed = join(r.main, 'node_modules', '@cleocode', 'core', 'dist', 'x.js');
    // Released: a stamp with no worktree, or an unstamped install.
    expect(
      schemaWriteRefusal(r.store, { ...base, provenance: { linkedWorktree: null } }),
    ).toBeNull();
    expect(schemaWriteRefusal(r.store, { ...base, codePath: installed })).toBeNull();
    expect(
      schemaWriteRefusal(r.store, { ...base, codePath: join(r.main, 'dist', 'x.js') }),
    ).toBeNull();
    expect(schemaWriteRefusal(join(r.worktree, '.cleo', 'cleo.db'), base)).toBeNull();
    expect(schemaWriteRefusal(r.store, { ...base, env: { VITEST: 'true' } })).toBeNull();
    // A store below the fork sandbox marker (a CLI child a test spawned, no VITEST).
    expect(schemaWriteRefusal(r.store, { ...base, honourTestSandbox: true })).toBeNull();
    expect(
      schemaWriteRefusal(r.store, {
        ...base,
        env: { [ALLOW_WORKTREE_BUILD_MIGRATIONS_ENV]: '1' },
      }),
    ).toBeNull();
  });
});

describe('T12687 — the guarded handle denies every schema change', () => {
  it('denies ALTER, DROP and new CREATEs; allows no-op CREATE IF NOT EXISTS and data writes', () => {
    const r = scratchRepos();
    const seed = new DatabaseSync(r.store);
    seed.exec('CREATE TABLE t (id INTEGER PRIMARY KEY); CREATE TABLE attachments (id TEXT)');
    seed.close();

    asWorktreeBuild(r.build);
    const native = new DatabaseSync(r.store);
    try {
      expect(installSchemaWriteGuard(native)).toBe(true);
      // The open paths' own DDL: ensureColumns, the raw attachments ALTERs, rebuilds.
      expect(() => ensureColumns(native, 't', [{ name: 'shape', ddl: 'text' }], 'test')).toThrow(
        /not authorized/,
      );
      try {
        native.exec('ALTER TABLE attachments ADD COLUMN owner_version TEXT');
      } catch {
        /* sqlite.ts swallows this one; the column must still not appear */
      }
      expect(() => native.exec('DROP TABLE t')).toThrow(/not authorized/);
      expect(() => native.exec('CREATE TABLE t_new (id INTEGER)')).toThrow(/not authorized/);
      expect(() => native.exec('CREATE INDEX t_idx ON t (id)')).toThrow(/not authorized/);
      native.exec('CREATE TABLE IF NOT EXISTS t (id INTEGER PRIMARY KEY)');
      native.exec('INSERT INTO t (id) VALUES (1)');
      native.exec('CREATE TEMP TABLE scratch (x)');
    } finally {
      native.close();
    }
    expect(columns(r.store)).toEqual(['id']);
    expect(columns(r.store, 'attachments')).toEqual(['id']);
  });
});

describe('T12687 — a worktree build fails fast on pending migrations', () => {
  it('leaves the main store journal unchanged and names the pending migrations', () => {
    const r = scratchRepos();
    const released = lineage(join(r.main, '..', 'released'), [BASE]);
    const worktreeBuild = lineage(join(r.worktree, 'migrations'), [BASE, SLICE2]);

    openAndMigrate(r.store, released); // the released CLI built the store
    const before = journal(r.store);
    expect(before).toHaveLength(1);

    asWorktreeBuild(r.build);
    expect(() => openAndMigrate(r.store, worktreeBuild)).toThrow(
      new RegExp(
        `${E_WORKTREE_BUILD_SCHEMA}.*Pending migrations: 20260929000000_slice-2-union-shape`,
      ),
    );
    expect(journal(r.store)).toEqual(before);
    expect(columns(r.store)).toEqual(['id']);

    // With the explicit opt-in the same build migrates.
    asWorktreeBuild(r.build, { [ALLOW_WORKTREE_BUILD_MIGRATIONS_ENV]: '1' });
    openAndMigrate(r.store, worktreeBuild);
    expect(journal(r.store)).toHaveLength(2);
    expect(columns(r.store)).toEqual(['id', 'shape']);
  });

  it('the real store chokepoint refuses with the named error, not a bare SQL error', async () => {
    const r = scratchRepos();
    asWorktreeBuild(r.build);
    await expect(openDualScopeDbAtPath('project', r.store)).rejects.toThrow(
      E_WORKTREE_BUILD_SCHEMA,
    );
    // Nothing was migrated into the fresh store.
    const db = new DatabaseSync(r.store, { readOnly: true });
    try {
      expect(
        db
          .prepare("SELECT count(*) AS n FROM sqlite_master WHERE name = '__drizzle_migrations'")
          .get(),
      ).toEqual({ n: 0 });
    } finally {
      db.close();
    }
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

describe('T12687 review — stamp fails closed, marker scoping, attached schemas', () => {
  it('a stamp without linkedWorktree (git could not tell) falls back to the build path', () => {
    const r = scratchRepos();
    const dist = join(r.worktree, 'packages', 'core', 'dist');
    writeFileSync(
      join(dist, 'build-provenance.json'),
      JSON.stringify({ schema: 1, gitHead: null }),
    );
    expect(readBuildProvenance(r.build)).toBeNull();
    expect(devBuildWorktree({ codePath: r.build })).toBe(r.worktree);
    // A non-null, non-string value is not trusted either.
    writeFileSync(join(dist, 'build-provenance.json'), JSON.stringify({ linkedWorktree: 0 }));
    expect(devBuildWorktree({ codePath: r.build })).toBe(r.worktree);
  });

  it('the stamp script omits linkedWorktree when git cannot answer', () => {
    const r = scratchRepos();
    // A package outside any git checkout: git rev-parse fails there.
    const pkg = join(dirname(r.main), 'loose-pkg');
    mkdirSync(join(pkg, 'scripts'), { recursive: true });
    const script = fileURLToPath(
      new URL('../../../scripts/write-build-provenance.mjs', import.meta.url),
    );
    copyFileSync(script, join(pkg, 'scripts', 'write-build-provenance.mjs'));
    execFileSync(process.execPath, [join(pkg, 'scripts', 'write-build-provenance.mjs')], {
      env: { ...process.env, GIT_CEILING_DIRECTORIES: dirname(r.main) },
    });
    const stamp = JSON.parse(readFileSync(join(pkg, 'dist', 'build-provenance.json'), 'utf8'));
    expect('linkedWorktree' in stamp).toBe(false);
  });

  it('a sandbox marker inside a git checkout is refused', () => {
    const r = scratchRepos();
    writeFileSync(join(r.main, TEST_SANDBOX_MARKER), 'planted');
    expect(
      schemaWriteRefusal(r.store, {
        codePath: r.build,
        provenance: null,
        env: {},
        honourTestSandbox: true,
      }),
    ).not.toBeNull();
  });

  it('an exempt (in-memory) handle that ATTACHes a foreign store is guarded on that schema', () => {
    const r = scratchRepos();
    const seed = new DatabaseSync(r.store);
    seed.exec('CREATE TABLE t (id INTEGER PRIMARY KEY)');
    seed.close();

    asWorktreeBuild(r.build);
    const mem = new DatabaseSync(':memory:');
    try {
      expect(installSchemaWriteGuard(mem)).toBe(false); // main itself is allowed
      mem.exec('CREATE TABLE local_only (x)');
      mem.exec(`ATTACH DATABASE '${r.store}' AS foreign_store`);
      // Unmapped attached schema: denied until the map is refreshed.
      expect(() => mem.exec('CREATE TABLE foreign_store.added (x)')).toThrow(/not authorized/);
      refreshSchemaWriteGuard(mem);
      expect(() => mem.exec('ALTER TABLE foreign_store.t ADD COLUMN shape TEXT')).toThrow(
        /not authorized/,
      );
      mem.exec('CREATE TABLE IF NOT EXISTS foreign_store.t (id INTEGER PRIMARY KEY)');
      mem.exec('INSERT INTO foreign_store.t (id) VALUES (7)');
      mem.exec('CREATE TABLE local_two (x)');
    } finally {
      mem.close();
    }
    expect(columns(r.store)).toEqual(['id']);
  });

  it('DETACH then re-ATTACH of a foreign store under an allowed alias is guarded (review HIGH)', () => {
    const r = scratchRepos();
    const seed = new DatabaseSync(r.store);
    seed.exec('CREATE TABLE t (id INTEGER PRIMARY KEY)');
    seed.close();

    asWorktreeBuild(r.build);
    const mem = new DatabaseSync(':memory:');
    try {
      installSchemaWriteGuard(mem);
      mem.exec(`ATTACH DATABASE ':memory:' AS a`);
      refreshSchemaWriteGuard(mem); // `a` is now mapped as allowed (in-memory)
      mem.exec('DETACH DATABASE a');
      mem.exec(`ATTACH DATABASE '${r.store}' AS a`);
      // No refresh: the stale allowed policy for `a` must not apply.
      expect(() => mem.exec('ALTER TABLE a.t ADD COLUMN probe TEXT')).toThrow(/not authorized/);
      refreshSchemaWriteGuard(mem);
      expect(() => mem.exec('ALTER TABLE a.t ADD COLUMN probe TEXT')).toThrow(/not authorized/);
    } finally {
      mem.close();
    }
    expect(columns(r.store)).toEqual(['id']);
  });
});
