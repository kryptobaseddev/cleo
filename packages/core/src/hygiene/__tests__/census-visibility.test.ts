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
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { computeProjectHash, resolveWorktreeRootForHash } from '@cleocode/paths';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const TASKS = new Map<string, string>();
// The foreign-store verdict is stubbed readable: these fixtures' project
// roots are tmpdirs with no `.cleo/`, and the real probe would skip the
// (mocked) store. The live, mock-free preflight test is
// census-store-preflight-live.test.ts (T14440 review P1a).
vi.mock('../../doctor/migrations.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../doctor/migrations.js')>()),
  projectStoreReadVerdict: vi.fn(() => 'readable'),
}));

vi.mock('../../store/sqlite.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../store/sqlite.js')>()),
  // T14440: the enrichment reads through the strictly read-only accessor.
  openProjectTasksReadOnly: vi.fn(
    () =>
      ({
        db: {
          prepare: () => ({
            all: (...ids: string[]) =>
              ids.filter((id) => TASKS.has(id)).map((id) => ({ id, status: TASKS.get(id) })),
          }),
        },
        path: 'stub',
        close: vi.fn(),
      }) as never,
  ),
}));

import { mergedBranchCounts, runWorktreeCensus } from '../census.js';

// The merged-branch probe goes through the napi worktrunk binding; stub the
// plan so the rollup is deterministic without a native build.
vi.mock('@cleocode/worktree', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@cleocode/worktree')>()),
  buildGitAwarePrunePlan: vi.fn(() => ({
    integrationTarget: 'main',
    candidates: [
      {
        branch: 'task/merged-x',
        label: 'task/merged-x',
        kind: 'branch_only',
        reason: 'integrated',
      },
    ],
  })),
}));

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

  it('rolls worktrees and bytes up per project, and names orphan hash directories', async () => {
    // An unregistered project: an orphan hash dir. A registered project with
    // NO worktrees still gets its rollup and branch counts (P2e).
    const c = repo('c');
    worktree(c, 'T9');
    const b = repo('b');
    const out = await runWorktreeCensus({ projects: [a, b], recordDir, pnpmStore: null });
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
});
