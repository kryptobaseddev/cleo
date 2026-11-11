/**
 * The census never opens a foreign store it cannot read without writing, and
 * never writes a store it MAY read — on every path, the in-use probe
 * included (T14440 review round 3, census AC3).
 *
 * Two REAL fixture stores, the real store layer underneath the census — no
 * mocks between the census and the files, and NO warmed `getDb` binding (the
 * suite closes every database after fixture setup, so the census starts from
 * a cold process state). Each test hashes the main database file AND its
 * `-wal` and `-shm` sidecars before and after:
 *
 * - old floor: the journal holds one installed hash (later migrations
 *   pending). The census must skip it entirely. Replacing the read-only
 *   accessor with `getDb` fails this test: the writable open would migrate
 *   the store and change its bytes.
 * - readable current: task statuses are immutable display snapshots. Even a
 *   terminal task never reaches a writable accessor, reaper probe or disposal.
 *
 * @task T14440
 */

import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { computeProjectHash, resolveWorktreeRootForHash } from '@cleocode/paths';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { resolveCorePackageMigrationsFolder } from '../../store/resolve-migrations-folder.js';

import { runWorktreeCensus } from '../census.js';

const getDbCalls = vi.hoisted(() => ({ calls: [] as string[] }));
vi.mock('../../store/sqlite.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../store/sqlite.js')>();
  return {
    ...actual,
    getDb: vi.fn(async (cwd?: string) => {
      getDbCalls.calls.push(cwd ?? '<ambient>');
      return actual.getDb(cwd);
    }),
  };
});

const git = (cwd: string, ...args: string[]): string =>
  execFileSync('git', ['-c', 'user.name=T', '-c', 'user.email=t@e.x', ...args], {
    cwd,
    encoding: 'utf-8',
    stdio: 'pipe',
  }).trim();

/** Hash the main database file and its WAL/SHM sidecars (missing → 'none'). */
function storeFingerprint(path: string): string {
  const hash = createHash('sha256');
  for (const suffix of ['', '-wal', '-shm']) {
    const file = `${path}${suffix}`;
    hash.update(`${suffix}:`);
    hash.update(existsSync(file) ? readFileSync(file) : 'none');
    hash.update('\n');
  }
  return hash.digest('hex');
}

/** The number of applied migrations in a store's journal (raw read). */
function journalCount(path: string): number {
  const db = new DatabaseSync(path);
  try {
    const has = db
      .prepare(
        "SELECT 1 FROM main.sqlite_master WHERE type = 'table' AND name = '__drizzle_migrations'",
      )
      .get();
    if (has === undefined) return 0;
    return (
      db.prepare('SELECT count(*) AS n FROM main."__drizzle_migrations"').all() as Array<{
        n: number;
      }>
    )[0]?.n as number;
  } finally {
    db.close();
  }
}

const prevHome = process.env['CLEO_HOME'];
const prevCleoDir = process.env['CLEO_DIR'];
const prevCleoRoot = process.env['CLEO_ROOT'];
let base: string;
let recordDir: string;
let projectRoot: string;
let dbPath: string;

/** A registered project with one worktree and a pinned store path. */
function fixture(): void {
  projectRoot = join(base, 'proj');
  mkdirSync(projectRoot);
  git(projectRoot, 'init', '-q', '-b', 'main');
  writeFileSync(join(projectRoot, 'a.txt'), 'a\n');
  git(projectRoot, 'add', '.');
  git(projectRoot, 'commit', '-q', '-m', 'init');
  const wtDir = resolveWorktreeRootForHash(computeProjectHash(projectRoot));
  mkdirSync(wtDir, { recursive: true });
  git(projectRoot, 'worktree', 'add', '-q', '-b', 'task/T1', join(wtDir, 'T1'), 'main');
  dbPath = join(projectRoot, '.cleo', 'cleo.db');
  mkdirSync(join(projectRoot, '.cleo'), { recursive: true });
  process.env['CLEO_DIR'] = join(projectRoot, '.cleo');
}

/** An old-floor store in WAL mode: the journal holds exactly one installed migration. */
function seedOldFloorStore(): void {
  const db = new DatabaseSync(dbPath);
  db.exec('PRAGMA journal_mode=WAL');
  db.exec('CREATE TABLE __drizzle_migrations (id INTEGER PRIMARY KEY, hash TEXT)');
  const folder = resolveCorePackageMigrationsFolder('drizzle-cleo-project');
  const first = readdirSync(folder).sort()[0];
  if (first === undefined) throw new Error('no installed project migrations');
  const hash = createHash('sha256')
    .update(readFileSync(join(folder, first, 'migration.sql')).toString())
    .digest('hex');
  db.prepare('INSERT INTO __drizzle_migrations (hash) VALUES (?)').run(hash);
  db.close();
}

beforeEach(() => {
  base = realpathSync(mkdtempSync(join(tmpdir(), 'census-preflight-')));
  process.env['CLEO_HOME'] = join(base, 'cleo-home');
  recordDir = join(base, 'census');
  fixture();
});

afterEach(async () => {
  const { closeAllDatabases } = await import('../../store/sqlite.js');
  await closeAllDatabases();
  if (prevHome === undefined) delete process.env['CLEO_HOME'];
  else process.env['CLEO_HOME'] = prevHome;
  if (prevCleoDir === undefined) delete process.env['CLEO_DIR'];
  else process.env['CLEO_DIR'] = prevCleoDir;
  if (prevCleoRoot === undefined) delete process.env['CLEO_ROOT'];
  else process.env['CLEO_ROOT'] = prevCleoRoot;
  rmSync(base, { recursive: true, force: true });
});

describe('census foreign-store gate against real stores (T14440 P1a)', () => {
  it('skips an old-floor store without migrating it: bytes, sidecars and journal unchanged', async () => {
    seedOldFloorStore();
    const before = storeFingerprint(dbPath);

    const out = await runWorktreeCensus({
      projects: [projectRoot],
      recordDir,
      pnpmStore: null,
    });
    if ('skipped' in out) throw new Error(out.skipped);
    const { record } = out;

    // The rollup names why the store was not read...
    const rollup = record.projects.find((p) => p.project === projectRoot);
    expect(rollup?.storeRead).toBe('status unknown');
    // ...so the row's task status is null (nothing was read)...
    const row = record.rows.find((r) => r.path.endsWith('T1'));
    expect(row?.taskStatus).toBeNull();
    expect(storeFingerprint(dbPath)).toBe(before);
    const after = new DatabaseSync(dbPath);
    const journalRows = (
      after.prepare('SELECT count(*) AS n FROM __drizzle_migrations').all() as Array<{ n: number }>
    )[0]?.n;
    after.close();
    expect(journalRows).toBe(1);
  });

  it('a live WAL: the census reads a display snapshot, creates no sidecars, migrates nothing', async () => {
    // Round 6: the store stays in WAL mode with an UNCHECKPOINTED commit (a
    // raw writable connection is held open across the census). The census's
    // foreign status read is an immutable, sidecar-free snapshot that may lag
    // these writes — labelled as such — and the non-terminal task means the
    // census touches nothing else: no probe, no sidecars, no migration.
    const { getDb } = await import('../../store/sqlite.js');
    await getDb(projectRoot);
    const db = new DatabaseSync(dbPath);
    db.prepare(
      "INSERT INTO tasks_tasks (id, title, status, pipeline_stage) VALUES ('T1', 't', 'pending', 'implementation')",
    ).run();
    db.prepare(
      `INSERT INTO tasks_agent_instances
         (id, agent_type, status, task_id, started_at, metadata_json)
       VALUES ('w-live', 'executor', 'starting', 'T1', datetime('now'), ?)`,
    ).run(
      JSON.stringify({
        kind: 'worker',
        instanceId: 'i-live',
        agentId: 'a-live',
        provider: 'test',
        pid: null,
        pgid: null,
        worktree: '/elsewhere/none',
      }),
    );
    db.close();
    const { closeAllDatabases } = await import('../../store/sqlite.js');
    await closeAllDatabases();
    // The live WAL: a writable connection that stays open, committing an
    // open worker record WITHOUT a checkpoint.
    const journalBefore = journalCount(dbPath);
    const live = new DatabaseSync(dbPath);
    live.exec('PRAGMA wal_checkpoint(TRUNCATE)');
    live
      .prepare(
        `INSERT INTO tasks_agent_instances
           (id, agent_type, status, task_id, started_at, metadata_json)
         VALUES ('w-live2', 'executor', 'starting', 'T1', datetime('now'), ?)`,
      )
      .run(
        JSON.stringify({
          kind: 'worker',
          instanceId: 'i-live2',
          agentId: 'a-live2',
          provider: 'test',
          pid: null,
          pgid: null,
          worktree: '/elsewhere/none2',
        }),
      );
    expect(existsSync(`${dbPath}-wal`)).toBe(true);

    const before = storeFingerprint(dbPath);
    const out = await runWorktreeCensus({
      projects: [projectRoot],
      recordDir,
      pnpmStore: null,
    });
    if ('skipped' in out) throw new Error(out.skipped);
    const { record } = out;

    const rollup = record.projects.find((p) => p.project === projectRoot);
    expect(rollup?.storeRead).toBe('snapshot: may lag uncommitted writes');
    // The snapshot's task state is display-only, never a removal candidate.
    const row = record.rows.find((r) => r.path.endsWith('T1'));
    expect(row?.removed).toBeUndefined();
    expect(storeFingerprint(dbPath)).toBe(before);
    // And no migration ran on the foreign store.
    expect(journalCount(dbPath)).toBe(journalBefore);
    live.close();
  });

  it('(3) a TERMINAL task in a foreign WAL store: no getDb, no sidecars, liveness unknown, not a candidate', async () => {
    // Round-7 item 3: a done task in a foreign WAL-mode store with an
    // uncheckpointed commit. The census must (a) never call getDb on that
    // store (spied), (b) create no sidecars and run no migration, (c) report
    // liveness 'unknown (foreign project)', and (d) never mark the row a
    // removal candidate.
    // Fixture: build via the REAL migrator, seed a DONE task, then hold a
    // raw writable connection open with an uncheckpointed worker commit.
    const { getDb } = await import('../../store/sqlite.js');
    await getDb(projectRoot);
    const db = new DatabaseSync(dbPath);
    db.close();
    const { closeAllDatabases } = await import('../../store/sqlite.js');
    await closeAllDatabases();
    const live = new DatabaseSync(dbPath);
    live
      .prepare(
        "INSERT INTO tasks_tasks (id, title, status, pipeline_stage) VALUES ('T1', 't', 'done', 'contribution')",
      )
      .run();
    // Round-8 item (3): the done row must be IN the main database file (not
    // only in the WAL), so the immutable display snapshot truly sees the
    // terminal status.
    live.exec('PRAGMA wal_checkpoint(TRUNCATE)');
    // Keep a committed change in the WAL while the immutable snapshot sees done.
    live.prepare("UPDATE tasks_tasks SET title = 'live WAL' WHERE id = 'T1'").run();
    expect(existsSync(`${dbPath}-wal`)).toBe(true);

    getDbCalls.calls.length = 0;
    const journalBeforeTerm = journalCount(dbPath);
    const before = storeFingerprint(dbPath);
    const out = await runWorktreeCensus({
      projects: [projectRoot],
      recordDir,
      pnpmStore: null,
    });
    if ('skipped' in out) throw new Error(out.skipped);
    const { record } = out;

    // No writable open, including through listing or liveness enrichment.
    expect(
      getDbCalls.calls.filter((p) => p.startsWith(projectRoot) || p === '<ambient>').length,
    ).toBe(0);
    expect(storeFingerprint(dbPath)).toBe(before);
    expect(journalCount(dbPath)).toBe(journalBeforeTerm);
    // (c)+(d) liveness 'unknown (foreign project)', never a candidate.
    const row = record.rows.find((r) => r.path.endsWith('T1'));
    expect(row?.category).toBe('unknown');
    expect(row?.taskStatus).toBe('done');
    expect(row?.keepReason).toBe('unknown (foreign project)');
    expect(row?.selected).toBeUndefined();
    expect(row?.removed).toBeUndefined();
    expect(record.rows.some((r) => r.category === 'redundant')).toBe(false);
    live.close();
  });

  it('reads a readable foreign store as a display snapshot: statuses flow, labelled', async () => {
    // Build with the real migrator before measurement, then close every binding.
    const { getDb } = await import('../../store/sqlite.js');
    await getDb(projectRoot);
    const db = new DatabaseSync(dbPath);
    db.prepare(
      "INSERT INTO tasks_tasks (id, title, status, pipeline_stage) VALUES ('T1', 't', 'pending', 'implementation')",
    ).run();
    db.close();
    const { closeAllDatabases } = await import('../../store/sqlite.js');
    await closeAllDatabases();

    const out = await runWorktreeCensus({
      projects: [projectRoot],
      recordDir,
      pnpmStore: null,
    });
    if ('skipped' in out) throw new Error(out.skipped);
    const { record } = out;

    const rollup = record.projects.find((p) => p.project === projectRoot);
    expect(rollup?.storeRead).toBe('snapshot: may lag uncommitted writes');
    // The snapshot actually read the row — an opener that failed early
    // (caught) would leave this null and fail the test.
    const row = record.rows.find((r) => r.path.endsWith('T1'));
    expect(row?.taskStatus).toBe('pending');
  });

  it('reads the named foreign project even when CLEO_DIR pins a different store', async () => {
    const { getDb, closeAllDatabases } = await import('../../store/sqlite.js');
    await getDb(projectRoot);
    const db = new DatabaseSync(dbPath);
    db.prepare(
      "INSERT INTO tasks_tasks (id, title, status, pipeline_stage) VALUES ('T1', 't', 'done', 'contribution')",
    ).run();
    db.close();
    await closeAllDatabases();
    const pinned = join(base, 'pinned');
    mkdirSync(pinned);
    const pinnedDb = join(pinned, 'cleo.db');
    writeFileSync(pinnedDb, readFileSync(dbPath));
    const other = new DatabaseSync(pinnedDb);
    other.prepare("UPDATE tasks_tasks SET status = 'pending' WHERE id = 'T1'").run();
    other.close();
    writeFileSync(
      join(projectRoot, '.cleo', 'project.json'),
      JSON.stringify({ schemaVersion: 1, id: 'fixture-project', name: 'proj' }),
    );
    process.env['CLEO_ROOT'] = projectRoot;
    process.env['CLEO_DIR'] = pinned;
    const before = storeFingerprint(dbPath);
    const pinnedBefore = storeFingerprint(pinnedDb);
    getDbCalls.calls.length = 0;

    const out = await runWorktreeCensus({ projects: [projectRoot], recordDir, pnpmStore: null });
    if ('skipped' in out) throw new Error(out.skipped);
    expect(out.record.rows.find((r) => r.taskId === 'T1')?.taskStatus).toBe('done');
    expect(out.record.rows.find((r) => r.taskId === 'T1')?.keepReason).toBe(
      'unknown (foreign project)',
    );
    expect(getDbCalls.calls).toEqual([]);
    expect(storeFingerprint(dbPath)).toBe(before);
    expect(storeFingerprint(pinnedDb)).toBe(pinnedBefore);
  });
});
