/**
 * The census never opens a foreign store it cannot read without writing
 * (T14440 review P1a, census AC3), and never writes a store it MAY read.
 *
 * Two REAL fixture stores, the real store layer underneath the census — no
 * mocks between the census and the files:
 *
 * - old floor: the journal holds one installed hash (later migrations
 *   pending). The census must skip it entirely; the fixture is byte-identical
 *   after. Removing the gate fails this test: the writable open would
 *   migrate the store and change its bytes.
 * - readable current: the journal is fully applied (the fixture store was
 *   built by the real migrator in setup). The census reads task status
 *   through the read-only accessor and the store is STILL byte-identical —
 *   routing the read through the writable `getDb` instead would fail, since
 *   that open restores/seeds even when the journal is current.
 *
 * @task T14440
 */

import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
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

// The merged-branch probe goes through the napi worktrunk binding; stub the
// plan so no native build is needed. The lock reader and disposal engine stay
// real, and — the point of this file — the store layer stays real.
vi.mock('@cleocode/worktree', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@cleocode/worktree')>()),
  buildGitAwarePrunePlan: vi.fn(() => ({
    integrationTarget: 'main',
    candidates: [],
  })),
}));

import { runWorktreeCensus } from '../census.js';

const git = (cwd: string, ...args: string[]): string =>
  execFileSync('git', ['-c', 'user.name=T', '-c', 'user.email=t@e.x', ...args], {
    cwd,
    encoding: 'utf-8',
    stdio: 'pipe',
  }).trim();

const sha256File = (path: string): string =>
  createHash('sha256').update(readFileSync(path)).digest('hex');

const prevHome = process.env['CLEO_HOME'];
const prevCleoDir = process.env['CLEO_DIR'];
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

/** An old-floor store: the journal holds exactly one installed migration. */
function seedOldFloorStore(): void {
  const db = new DatabaseSync(dbPath);
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

afterEach(() => {
  if (prevHome === undefined) delete process.env['CLEO_HOME'];
  else process.env['CLEO_HOME'] = prevHome;
  if (prevCleoDir === undefined) delete process.env['CLEO_DIR'];
  else process.env['CLEO_DIR'] = prevCleoDir;
  rmSync(base, { recursive: true, force: true });
});

describe('census foreign-store gate against real stores (T14440 P1a)', () => {
  it('skips an old-floor store without migrating it: bytes and journal unchanged after the census', async () => {
    seedOldFloorStore();
    const shaBefore = sha256File(dbPath);

    const out = await runWorktreeCensus({
      projects: [projectRoot],
      recordDir,
      pnpmStore: null,
    });
    if ('skipped' in out) throw new Error(out.skipped);
    const { record } = out;

    // The rollup names why the store was not read...
    const rollup = record.projects.find((p) => p.project === projectRoot);
    expect(rollup?.storeRead).toBe('not read: tasks schema missing');
    // ...so the row's task status is null (nothing was read)...
    const row = record.rows.find((r) => r.path.endsWith('T1'));
    expect(row?.taskStatus).toBeNull();
    // ...and the fixture store is byte-identical: no migration ran. Removing
    // the gate fails here — the writable open would migrate the store.
    expect(sha256File(dbPath)).toBe(shaBefore);
    const after = new DatabaseSync(dbPath);
    const journalRows = (
      after.prepare('SELECT count(*) AS n FROM __drizzle_migrations').all() as Array<{ n: number }>
    )[0]?.n;
    after.close();
    expect(journalRows).toBe(1);
  });

  it('reads a readable current store through the read-only accessor: statuses flow, bytes unchanged', async () => {
    // Fixture construction: build the store with the REAL migrator (a write,
    // before any measurement) and seed one done task.
    const { getDb } = await import('../../store/sqlite.js');
    await getDb(projectRoot);
    const db = new DatabaseSync(dbPath);
    db.prepare(
      "INSERT INTO tasks_tasks (id, title, status, pipeline_stage) VALUES ('T1', 't', 'done', 'contribution')",
    ).run();
    db.close();

    const shaBefore = sha256File(dbPath);
    const out = await runWorktreeCensus({
      projects: [projectRoot],
      recordDir,
      pnpmStore: null,
    });
    if ('skipped' in out) throw new Error(out.skipped);
    const { record } = out;

    const rollup = record.projects.find((p) => p.project === projectRoot);
    expect(rollup?.storeRead).toBe('read');
    // The read-only enrichment actually read the row — an opener that failed
    // early (caught) would leave this null and fail the test.
    const row = record.rows.find((r) => r.path.endsWith('T1'));
    expect(row?.taskStatus).toBe('done');
    // And the store is byte-identical: the readable path restored/seeded nothing.
    expect(sha256File(dbPath)).toBe(shaBefore);
  });
});
