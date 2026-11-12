/**
 * The census's per-row visibility fields and machine rollups (T14440, AC1):
 * task status, activity/creation times, locks, dirty state, node_modules kind
 * and size, per-project merged-branch counts, orphan hash directories and the
 * pnpm store embedding.
 *
 * Real git over sandboxed repos; only the task store, the merged-branch
 * counter and the pnpm store are stubbed.
 *
 * @task T14440
 */

import { execFileSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { computeProjectHash, resolveWorktreeRootForHash } from '@cleocode/paths';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const TASKS = new Map<string, string>();
vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>();
  return { ...actual, execFileSync: vi.fn(actual.execFileSync) };
});
// Round 7: census fixtures classify as OWN (main's behaviour).
vi.mock('../../worktree/own-project.js', () => ({
  isOwnProjectStore: vi.fn(() => true),
}));

vi.mock('../../store/sqlite.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../store/sqlite.js')>()),
  // Round 6: the listing reads task statuses through getDb/getNativeTasksDb
  // (main behaviour); the stub yields the rows the test set in TASKS.
  getDb: vi.fn(async () => ({}) as never),
  getNativeTasksDb: vi.fn(
    () =>
      ({
        prepare: () => ({
          all: (...ids: string[]) =>
            ids.filter((id) => TASKS.has(id)).map((id) => ({ id, status: TASKS.get(id) })),
        }),
      }) as never,
  ),
}));

import { isOwnProjectStore } from '../../worktree/own-project.js';
import { mergedBranchCounts, prunePlanBounded, runWorktreeCensus } from '../census.js';

const git = (cwd: string, ...args: string[]): string =>
  execFileSync('git', ['-c', 'user.name=T', '-c', 'user.email=t@e.x', ...args], {
    cwd,
    encoding: 'utf-8',
    stdio: 'pipe',
  }).trim();

const prevHome = process.env['CLEO_HOME'];
let base: string;
let recordDir: string;
let a: string;
let paths: Record<string, string>;

/** A one-commit repository (node_modules pre-ignored, as real repos have). */
function repo(name: string): string {
  const root = join(base, name);
  mkdirSync(root);
  git(root, 'init', '-q', '-b', 'main');
  writeFileSync(join(root, 'a.txt'), 'a\n');
  writeFileSync(join(root, '.gitignore'), 'node_modules/\n');
  git(root, 'add', '.');
  git(root, 'commit', '-q', '-m', 'init');
  return root;
}

/** A canonical worktree of `root` for `taskId`, at main. */
function worktree(root: string, taskId: string): string {
  const dir = resolveWorktreeRootForHash(computeProjectHash(root));
  mkdirSync(dir, { recursive: true });
  const path = join(dir, taskId);
  git(root, 'worktree', 'add', '-q', '-b', `task/${taskId}`, path, 'main');
  return path;
}

beforeEach(() => {
  base = realpathSync(mkdtempSync(join(tmpdir(), 'census-vis-')));
  process.env['CLEO_HOME'] = join(base, 'cleo-home');
  recordDir = join(base, 'census');
  TASKS.clear();
  vi.mocked(isOwnProjectStore).mockReturnValue(true);
  a = repo('a');
  paths = {
    clean: worktree(a, 'T1'), // done, clean
    dirty: worktree(a, 'T2'), // pending, untracked work
  };
  writeFileSync(join(paths.dirty ?? '', 'wip.txt'), 'wip\n');
  TASKS.set('T1', 'done');
  TASKS.set('T2', 'pending');
});

afterEach(() => {
  if (prevHome === undefined) delete process.env['CLEO_HOME'];
  else process.env['CLEO_HOME'] = prevHome;
  rmSync(base, { recursive: true, force: true });
});

describe('census visibility fields (T14440 AC1)', () => {
  it('rows carry task status, activity, locks, dirty state and node_modules kind/size', async () => {
    // node_modules: real with one file on the clean worktree, symlink on the dirty one.
    const nm = join(paths.clean ?? '', 'node_modules');
    mkdirSync(join(nm, 'pkg'), { recursive: true });
    writeFileSync(join(nm, 'pkg', 'i.js'), 'x');
    symlinkSync('/nonexistent-target', join(paths.dirty ?? '', 'node_modules'));

    const out = await runWorktreeCensus({
      projects: [a],
      recordDir,
      pnpmStore: { path: join(base, 'store'), apparentBytes: 1234 },
      branchesOf: async () => ({ mergedLocal: 1, mergedRemote: 0 }),
    });
    if ('skipped' in out) throw new Error(out.skipped);
    const { record } = out;

    expect(record.schemaVersion).toBe(2);
    const byPath = new Map(record.rows.map((r) => [r.path, r]));
    const clean = byPath.get(paths.clean ?? '');
    const dirty = byPath.get(paths.dirty ?? '');
    expect(clean).toMatchObject({
      taskStatus: 'done',
      gitLocked: false,
      taskLocked: false,
      dirtyFiles: 0,
      nodeModules: 'real',
    });
    expect(clean?.nodeModulesBytes).toBeGreaterThan(0);
    expect(typeof clean?.lastActivity).toBe('string');
    expect(typeof clean?.createdAt).toBe('string');
    expect(dirty).toMatchObject({
      taskStatus: 'pending',
      nodeModules: 'symlink',
      nodeModulesBytes: 0,
    });
    // wip.txt plus the unignored node_modules symlink are untracked entries.
    expect(dirty?.dirtyFiles).toBeGreaterThanOrEqual(1);
    // The record embeds the (stubbed) pnpm store untouched.
    expect(record.pnpmStore).toEqual({ path: join(base, 'store'), apparentBytes: 1234 });
  });

  it('disables optional locks for Git reads, including status in foreign worktrees', async () => {
    vi.mocked(isOwnProjectStore).mockReturnValueOnce(false);
    vi.mocked(execFileSync).mockClear();
    const out = await runWorktreeCensus({
      projects: [a],
      recordDir,
      pnpmStore: null,
      branchesOf: (root) => mergedBranchCounts(root, Infinity, async () => ({ candidates: [] })),
    });
    if ('skipped' in out) throw new Error(out.skipped);
    for (const path of Object.values(paths)) {
      expect(execFileSync).toHaveBeenCalledWith(
        'git',
        ['--no-optional-locks', 'status', '--porcelain'],
        expect.objectContaining({ cwd: path }),
      );
    }
    expect(execFileSync).toHaveBeenCalledWith(
      'git',
      [
        '--no-optional-locks',
        'for-each-ref',
        '--merged',
        'main',
        '--format=%(refname:short)',
        'refs/remotes',
      ],
      expect.objectContaining({ cwd: a }),
    );
    expect(out.record.rows.find((row) => row.path === paths.clean)?.dirtyFiles).toBe(0);
    expect(out.record.rows.find((row) => row.path === paths.dirty)?.dirtyFiles).toBe(1);
  });

  it('rolls worktrees and bytes up per project, and names orphan hash directories', async () => {
    // An unregistered project: an orphan hash dir. A registered project with
    // NO worktrees still gets its rollup and branch counts (P2e).
    const c = repo('c');
    worktree(c, 'T9');
    const b = repo('b');
    const out = await runWorktreeCensus({
      projects: [a, b],
      recordDir,
      pnpmStore: null,
      branchesOf: async () => ({ mergedLocal: 1, mergedRemote: 0 }),
    });
    if ('skipped' in out) throw new Error(out.skipped);
    const { record } = out;

    const aRollup = record.projects.find((p) => p.project === a);
    expect(aRollup).toMatchObject({
      worktrees: 2,
      orphan: false,
      mergedLocalBranches: 1, // the stubbed SDK plan's one merged branch
      mergedRemoteBranches: 0, // no remote refs in a fresh repo
    });
    expect(aRollup?.apparentBytes).toBe(
      record.rows.filter((r) => r.project === a).reduce((n, r) => n + r.apparentBytes, 0),
    );
    // A registered project with zero worktrees is not dropped (P2e).
    const bRollup = record.projects.find((p) => p.project === b);
    expect(bRollup).toMatchObject({ worktrees: 0, apparentBytes: 0, orphan: false });
    expect(bRollup?.mergedLocalBranches).toBe(1); // the probe still ran for it
    const orphanHash = computeProjectHash(c);
    expect(record.orphanFolders).toEqual([
      { projectHash: orphanHash, worktrees: 1, apparentBytes: expect.any(Number) },
    ]);
    expect(record.projects.find((p) => p.projectHash === orphanHash)).toMatchObject({
      project: null,
      orphan: true,
      worktrees: 1,
    });
  });

  it('a spent wall-clock budget stops the branch probes: nulls, never zeros', async () => {
    const counts = await mergedBranchCounts(a, Date.now() - 1);
    expect(counts).toEqual({ mergedLocal: null, mergedRemote: null });
  });

  it('counts merged remote branches via git, excluding */HEAD', async () => {
    // A remote-tracking ref inside main's history; origin/HEAD must not count.
    const sha = git(a, 'rev-parse', 'main');
    git(a, 'update-ref', 'refs/remotes/origin/ship', sha);
    git(a, 'update-ref', 'refs/remotes/origin/HEAD', sha);

    const counts = await mergedBranchCounts(a);
    expect(counts.mergedRemote).toBe(1); // origin/ship; origin/HEAD excluded
  });

  it('counts merged branches against the repository default branch instead of main', async () => {
    const root = repo('master-project');
    git(root, 'branch', '-m', 'master');
    const sha = git(root, 'rev-parse', 'master');
    git(root, 'update-ref', 'refs/remotes/origin/master', sha);
    git(root, 'update-ref', 'refs/remotes/origin/ship', sha);
    const planOf = vi.fn(async () => ({
      candidates: [{ kind: 'branch_only', branch: 'landed' }],
    }));
    const counts = await mergedBranchCounts(root, Infinity, planOf);
    expect(planOf).toHaveBeenCalledWith(root, 'master', Infinity);
    expect(counts).toEqual({ mergedLocal: 1, mergedRemote: 1 });
  });

  it('terminates a slow probe at the deadline; the worker EXITED before the census resolves and the timer marker never appears', async () => {
    // The running cleocode checkout: hundreds of branches make the SDK walk
    // outlive a 5 ms deadline, so the worker is terminated mid-run. Two
    // proofs (round-7 review): (a) the worker's 'exit' event fires BEFORE
    // prunePlanBounded resolves — the census never releases its lock over a
    // live native walk; (b) the worker's marker sits behind a 300 ms timer
    // reachable only after the walk — the test waits past that delay before
    // asserting absence, so premature resolution cannot fake the pass.
    const repo = process.cwd();
    const marker = join(base, 'killed.marker');
    let exited = false;
    const plan = await prunePlanBounded(repo, 'main', Date.now() + 5, marker, 300, () => {
      exited = true;
    });
    expect(plan).toBeNull();
    expect(exited).toBe(true);
    await new Promise((r) => setTimeout(r, 450));
    expect(existsSync(marker)).toBe(false);
  });

  it('control: an unconstrained probe completes, its timer fires the marker, and the worker exits', async () => {
    const repo = process.cwd();
    const marker = join(base, 'completed.marker');
    let exited = false;
    const plan = await prunePlanBounded(repo, 'main', Number.POSITIVE_INFINITY, marker, 50, () => {
      exited = true;
    });
    expect(plan).not.toBeNull();
    await new Promise((r) => setTimeout(r, 250));
    expect(existsSync(marker)).toBe(true);
    expect(exited).toBe(true);
  });

  it('(4) the production wrapper runs from a parent started with --input-type=module', async () => {
    // Reproduces the round-7 P2: the lazy census child spawns node with
    // --input-type=module; a Worker inheriting that flag throws
    // ERR_INPUT_TYPE_NOT_ALLOWED. The child below IS such a parent; the
    // production wrapper must still complete using its own Worker configuration.
    const censusFile = fileURLToPath(new URL('../../../dist/hygiene/census.js', import.meta.url));
    const script = [
      `const { pathToFileURL } = await import('node:url');`,
      `const { prunePlanBounded } = await import(pathToFileURL(process.env.CENSUS_FILE));`,
      `let exited = false;`,
      `const plan = await prunePlanBounded(process.cwd(), 'main', Infinity, undefined, undefined, () => { exited = true; });`,
      `if (plan === null || !exited) throw new Error('production worker did not complete');`,
      `process.stdout.write('RESULT ' + JSON.stringify(plan));`,
    ].join('\n');
    const out = execFileSync(process.execPath, ['--input-type=module', '-e', script], {
      cwd: process.cwd(),
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe'],
      timeout: 60_000,
      env: {
        ...process.env,
        CENSUS_FILE: censusFile,
      },
    });
    expect(out).toContain('RESULT');
    expect(out).not.toContain('ERR_INPUT_TYPE_NOT_ALLOWED');
    expect(out).not.toContain('ERR');
  });

  it('an infinite deadline sets no timer: the probe runs to completion', async () => {
    // Regression for the TimeoutOverflowWarning: Infinity reaching setTimeout
    // clamps to 1 ms and killed every probe before it finished.
    const counts = await mergedBranchCounts(a);
    expect(counts.mergedLocal).not.toBeNull();
    expect(counts.mergedRemote).not.toBeNull();
  });
});
