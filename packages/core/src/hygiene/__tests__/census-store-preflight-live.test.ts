/**
 * The census never opens a foreign store it cannot read without writing
 * (T14440 review P1a, census AC3).
 *
 * A REAL fixture store sits at an old migration floor (its journal holds one
 * installed hash; later migrations are pending). The census runs for that
 * project with the real store layer — no mocks between the census and the
 * file — and the fixture's bytes and journal must be byte-identical after:
 * the preflight must have skipped it, because opening it through `getDb`
 * would have migrated (written) it.
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
// real.
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

beforeEach(() => {
  base = realpathSync(mkdtempSync(join(tmpdir(), 'census-preflight-')));
  process.env['CLEO_HOME'] = join(base, 'cleo-home');
  recordDir = join(base, 'census');

  // The registered project, with one worktree.
  projectRoot = join(base, 'proj');
  mkdirSync(projectRoot);
  git(projectRoot, 'init', '-q', '-b', 'main');
  writeFileSync(join(projectRoot, 'a.txt'), 'a\n');
  git(projectRoot, 'add', '.');
  git(projectRoot, 'commit', '-q', '-m', 'init');
  const wtDir = resolveWorktreeRootForHash(computeProjectHash(projectRoot));
  mkdirSync(wtDir, { recursive: true });
  git(projectRoot, 'worktree', 'add', '-q', '-b', 'task/T1', join(wtDir, 'T1'), 'main');

  // A REAL store at an old migration floor: journal holds one installed hash.
  dbPath = join(projectRoot, '.cleo', 'cleo.db');
  mkdirSync(join(projectRoot, '.cleo'), { recursive: true });
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

  // Pin the store resolution to the fixture (tmpdir sits outside $HOME).
  process.env['CLEO_DIR'] = join(projectRoot, '.cleo');
});

afterEach(() => {
  if (prevHome === undefined) delete process.env['CLEO_HOME'];
  else process.env['CLEO_HOME'] = prevHome;
  if (prevCleoDir === undefined) delete process.env['CLEO_DIR'];
  else process.env['CLEO_DIR'] = prevCleoDir;
  rmSync(base, { recursive: true, force: true });
});

function writeFileSyncSafe(path: string, body: string): void {
  // node:fs writeFileSync, named for the TSDoc-free helper scope.
  // (imported directly at call sites via node:fs.)
  require('node:fs').writeFileSync(path, body);
}

describe('census foreign-store preflight against a real store (T14440 P1a)', () => {
  it('skips an old-floor store without migrating it: bytes and journal unchanged after the census', async () => {
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
    expect(rollup?.storeRead).toBe('not read: store behind this build (pending migrations)');
    // ...so the row's task status is null (nothing was read)...
    const row = record.rows.find((r) => r.path.endsWith('T1'));
    expect(row?.taskStatus).toBeNull();
    // ...and the fixture store is byte-identical: no migration ran.
    expect(sha256File(dbPath)).toBe(shaBefore);
    const after = new DatabaseSync(dbPath);
    const journalRows = (
      after.prepare('SELECT count(*) AS n FROM __drizzle_migrations').all() as Array<{ n: number }>
    )[0]?.n;
    after.close();
    expect(journalRows).toBe(1);
  });
});
