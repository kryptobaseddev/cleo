/**
 * The machine-wide worktree census (T14275) over real git: three projects'
 * worktrees under one sandboxed worktree root, two of them registered.
 *
 * Only the task store is stubbed (task statuses); git and the disposal
 * engine are real.
 *
 * @task T14275
 */

import { execFileSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { computeProjectHash, resolveWorktreeRootForHash } from '@cleocode/paths';
import { acquireWorktreeTaskLock, readWorktreeTaskLock } from '@cleocode/worktree';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const TASKS = new Map<string, string>();
vi.mock('../../store/sqlite.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../store/sqlite.js')>()),
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

import { acquireHeartbeatLock } from '../../tasks/merge-close.js';
import {
  apparentBytes,
  CENSUS_INTERVAL_MS,
  censusBriefingLine,
  censusSpawnAllowed,
  claimCensus,
  registeredProjects,
  runWorktreeCensus,
  startLazyCensus,
} from '../census.js';

const git = (cwd: string, ...args: string[]): string =>
  execFileSync('git', ['-c', 'user.name=T', '-c', 'user.email=t@e.x', ...args], {
    cwd,
    encoding: 'utf-8',
    stdio: 'pipe',
  }).trim();

const prevHome = process.env['CLEO_HOME'];
let base: string;
let recordDir: string;

/** A one-commit repository. */
function repo(name: string): string {
  const root = join(base, name);
  mkdirSync(root);
  git(root, 'init', '-q', '-b', 'main');
  writeFileSync(join(root, 'a.txt'), 'a\n');
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

let a: string;
let b: string;
let c: string;
let paths: Record<string, string>;

beforeEach(() => {
  base = realpathSync(mkdtempSync(join(tmpdir(), 'census-')));
  process.env['CLEO_HOME'] = join(base, 'cleo-home');
  recordDir = join(base, 'census');
  TASKS.clear();
  a = repo('a');
  b = repo('b');
  c = repo('c'); // never registered
  paths = {
    T1: worktree(a, 'T1'), // done, clean: redundant
    T2: worktree(a, 'T2'), // done, untracked work: keep
    T3: worktree(a, 'T3'), // pending: active
    T4: worktree(b, 'T4'), // done, clean, but another project: report only
    T5: worktree(c, 'T5'), // unregistered project: unknown
  };
  writeFileSync(join(paths.T2 ?? '', 'wip.txt'), 'wip\n');
  for (const id of ['T1', 'T2', 'T4', 'T5']) TASKS.set(id, 'done');
  TASKS.set('T3', 'pending');
  // A stray directory git does not list, inside a registered project's hash dir.
  paths.stray = join(resolveWorktreeRootForHash(computeProjectHash(a)), 'stray');
  mkdirSync(paths.stray);
  writeFileSync(join(paths.stray, 'notes.txt'), 'notes\n');
});

afterEach(() => {
  if (prevHome === undefined) delete process.env['CLEO_HOME'];
  else process.env['CLEO_HOME'] = prevHome;
  rmSync(base, { recursive: true, force: true });
});

describe('worktree census (T14275)', () => {
  it('reproduces completed locked worktrees across projects: previews, then removes all proven ones and retains branches', async () => {
    const more = ['T6', 'T7', 'T8'].map((id) => {
      TASKS.set(id, 'done');
      return worktree(a, id);
    });
    const safe = [paths.T1!, paths.T4!, ...more];
    for (const path of safe) git(a, 'worktree', 'lock', path);
    for (const id of ['T1', 'T6', 'T7', 'T8'])
      acquireWorktreeTaskLock({ projectHash: computeProjectHash(a), taskId: id });
    const preview = await runWorktreeCensus({ projects: [a, b], recordDir, allProjects: true });
    if ('skipped' in preview) throw new Error(preview.skipped);
    expect(
      preview.record.rows
        .filter((r) => r.selected)
        .map((r) => r.path)
        .sort(),
    ).toEqual(safe.sort());
    expect(readWorktreeTaskLock(computeProjectHash(a), 'T1')).not.toBeNull();
    expect(git(a, 'worktree', 'list', '--porcelain')).toContain('locked');
    for (const path of safe) expect(existsSync(path)).toBe(true);

    const applied = await runWorktreeCensus({
      projects: [a, b],
      recordDir,
      allProjects: true,
      apply: true,
    });
    if ('skipped' in applied) throw new Error(applied.skipped);
    expect(
      applied.record.rows
        .filter((r) => r.removed)
        .map((r) => r.path)
        .sort(),
    ).toEqual(safe.sort());
    for (const path of safe) expect(existsSync(path)).toBe(false);
    for (const id of ['T1', 'T6', 'T7', 'T8']) {
      expect(git(a, 'rev-parse', '--verify', `refs/heads/task/${id}`)).toBeTruthy();
      expect(readWorktreeTaskLock(computeProjectHash(a), id)).toBeNull();
    }
    for (const path of [a, b, paths.T2!, paths.T3!, paths.T5!, paths.stray!])
      expect(existsSync(path)).toBe(true);
    expect(
      readFileSync(join(a, '.cleo/audit/worktree-lifecycle.jsonl'), 'utf-8').trim().split('\n'),
    ).toHaveLength(4);
    expect(JSON.parse(readFileSync(applied.recordPath, 'utf-8'))).toEqual(applied.record);
  });

  it('honors TTL and retained size budget, selecting oldest eligible worktrees only until the target is reached', async () => {
    const young = await runWorktreeCensus({
      projects: [a, b],
      recordDir,
      allProjects: true,
      apply: true,
      ttlDays: 1,
    });
    if ('skipped' in young) throw new Error(young.skipped);
    expect(young.record.rows.some((r) => r.removed)).toBe(false);
    const total = young.record.apparentBytes;
    const trimmed = await runWorktreeCensus({
      projects: [a, b],
      recordDir,
      allProjects: true,
      apply: true,
      maxBytes: total - 1,
    });
    if ('skipped' in trimmed) throw new Error(trimmed.skipped);
    expect(trimmed.record.rows.filter((r) => r.removed)).toHaveLength(1);
    expect(
      trimmed.record.apparentBytes - trimmed.record.reclaimedApparentBytes,
    ).toBeLessThanOrEqual(total - 1);
    expect(existsSync(paths.T2!)).toBe(true);
    expect(existsSync(paths.T3!)).toBe(true);
  });

  it('covers unadopted external worktrees even when the project has no canonical hash directory', async () => {
    const external = join(base, 'external', 'lane');
    mkdirSync(join(base, 'external'));
    const root = repo('external-project');
    git(root, 'worktree', 'add', '-q', '-b', 'task/T90-slug', external, 'main');
    TASKS.set('T90', 'cancelled');
    // c's existing canonical worktree is deliberately unproven.
    writeFileSync(join(paths.T5!, 'unique.txt'), 'keep me');
    const out = await runWorktreeCensus({
      projects: [root],
      recordDir,
      allProjects: true,
      apply: true,
    });
    if ('skipped' in out) throw new Error(out.skipped);
    expect(out.record.rows.find((r) => r.path === external)?.removed).toBe(true);
    expect(existsSync(paths.T5!)).toBe(true);
    expect(git(root, 'rev-parse', '--verify', 'refs/heads/task/T90-slug')).toBeTruthy();
  });

  it('reaps a locally proven crashed worker, keeps a live task, and never discards unpushed commits', async () => {
    const crashed = worktree(a, 'T91');
    TASKS.set('T91', 'pending');
    acquireWorktreeTaskLock({
      projectHash: computeProjectHash(a),
      taskId: 'T91',
      holder: { pid: 2_147_483_647 },
    });
    const unique = worktree(a, 'T92');
    TASKS.set('T92', 'done');
    writeFileSync(join(unique, 'unique.txt'), 'unpublished');
    git(unique, 'add', '.');
    git(unique, 'commit', '-q', '-m', 'unique work');
    const out = await runWorktreeCensus({
      projects: [a],
      recordDir,
      allProjects: true,
      apply: true,
    });
    if ('skipped' in out) throw new Error(out.skipped);
    expect(out.record.rows.find((r) => r.path === crashed)).toMatchObject({
      crashed: true,
      removed: true,
    });
    expect(existsSync(unique)).toBe(true);
    expect(existsSync(paths.T3!)).toBe(true);
    expect(out.record.rows.find((r) => r.path === unique)?.keepReason).toContain('commits');
    const remote = join(base, 'remote.git');
    git(base, 'init', '--bare', '-q', remote);
    git(a, 'remote', 'add', 'origin', remote);
    git(unique, 'push', '-q', 'origin', 'task/T92');
    const pushed = await runWorktreeCensus({
      projects: [a],
      recordDir,
      allProjects: true,
      apply: true,
    });
    if ('skipped' in pushed) throw new Error(pushed.skipped);
    expect(pushed.record.rows.find((r) => r.path === unique)?.removed).toBe(true);
    expect(git(a, 'rev-parse', '--verify', 'refs/heads/task/T92')).toBeTruthy();
  });

  it('keeps ignored build output by default and exempts it only with the explicit merged-build flag', async () => {
    writeFileSync(join(a, '.gitignore'), 'dist/\n');
    git(a, 'add', '.gitignore');
    git(a, 'commit', '-q', '-m', 'ignore output');
    const path = worktree(a, 'T93');
    TASKS.set('T93', 'done');
    writeFileSync(join(path, 'source.txt'), 'source');
    git(path, 'add', '.');
    git(path, 'commit', '-q', '-m', 'build source');
    git(a, 'merge', '--no-ff', '-q', '-m', 'integrated', 'task/T93');
    mkdirSync(join(path, 'dist'));
    writeFileSync(join(path, 'dist', 'bundle.js'), 'generated');
    const kept = await runWorktreeCensus({
      projects: [a],
      recordDir,
      allProjects: true,
      apply: true,
    });
    if ('skipped' in kept) throw new Error(kept.skipped);
    expect(kept.record.rows.find((r) => r.path === path)?.keepReason).toContain('ignored content');
    const removed = await runWorktreeCensus({
      projects: [a],
      recordDir,
      allProjects: true,
      apply: true,
      exemptRegenerable: true,
    });
    if ('skipped' in removed) throw new Error(removed.skipped);
    expect(existsSync(path)).toBe(false);
    expect(existsSync(join(a, '.cleo/archive/worktrees'))).toBe(false);
    expect(git(a, 'rev-parse', '--verify', 'refs/heads/task/T93')).toBeTruthy();
  });

  it('rejects invalid retention limits before creating a record or removing anything', async () => {
    for (const ttlDays of [-1, NaN, Infinity])
      await expect(runWorktreeCensus({ recordDir, ttlDays })).rejects.toThrow('non-negative');
    await expect(runWorktreeCensus({ recordDir, maxBytes: -1 })).rejects.toThrow('non-negative');
    expect(existsSync(recordDir)).toBe(false);
  });

  it('keeps known task worktrees when task state is unavailable and reports inaccessible projects', async () => {
    TASKS.clear();
    const missing = join(base, 'missing');
    const out = await runWorktreeCensus({
      projects: [missing, a, b],
      recordDir,
      allProjects: true,
      apply: true,
    });
    if ('skipped' in out) throw new Error(out.skipped);
    expect(out.record.partial).toBe(true);
    expect(out.record.projectErrors).toEqual([
      { project: missing, error: 'registered project path is unavailable' },
    ]);
    expect(out.record.rows.some((r) => r.removed)).toBe(false);
    expect(out.record.rows.find((r) => r.path === paths.T1)?.keepReason).toContain(
      'task state unavailable',
    );
    expect(existsSync(paths.T1!)).toBe(true);
    expect(existsSync(paths.T4!)).toBe(true);
  });

  it('report lists every worktree under the root by project with category, bytes and keep reason; removes nothing', async () => {
    const out = await runWorktreeCensus({ projects: [a, b], recordDir });
    if ('skipped' in out) throw new Error(out.skipped);
    const { record } = out;
    const byPath = new Map(record.rows.map((r) => [r.path, r]));
    expect(record.mode).toBe('report');
    expect(record.rows).toHaveLength(6);
    expect(byPath.get(paths.T1 ?? '')).toMatchObject({ project: a, category: 'redundant' });
    expect(byPath.get(paths.T2 ?? '')).toMatchObject({ project: a, category: 'keep' });
    expect(byPath.get(paths.T2 ?? '')?.keepReason).toContain('uncommitted or untracked');
    expect(byPath.get(paths.T3 ?? '')).toMatchObject({ project: a, category: 'active' });
    expect(byPath.get(paths.T4 ?? '')).toMatchObject({ project: b, category: 'redundant' });
    expect(byPath.get(paths.T5 ?? '')).toMatchObject({ project: null, category: 'unknown' });
    expect(byPath.get(paths.T5 ?? '')?.keepReason).toContain('no registered project');
    expect(byPath.get(paths.stray ?? '')).toMatchObject({ project: a, category: 'unknown' });
    for (const row of record.rows) expect(row.apparentBytes).toBeGreaterThan(0);
    expect(record.counts).toEqual({ active: 1, redundant: 2, keep: 1, unknown: 2 });
    expect(record.kept.map((k) => k.path).sort()).toEqual([paths.T2, paths.T5, paths.stray].sort());
    expect(record.dfDelta).toBeNull();
    for (const p of Object.values(paths)) expect(existsSync(p)).toBe(true);
    // One record per run, plus latest.json.
    expect(JSON.parse(readFileSync(out.recordPath, 'utf-8'))).toEqual(record);
    expect(JSON.parse(readFileSync(join(recordDir, 'latest.json'), 'utf-8'))).toEqual(record);
    expect(censusBriefingLine(recordDir)).toMatch(
      /^3 worktrees \([0-9.]+ GB\) kept: run `cleo hygiene census --report`$/,
    );
  });

  it('--apply removes only proof-redundant worktrees of the allowed project and records bytes reclaimed', async () => {
    const out = await runWorktreeCensus({
      projects: [a, b],
      recordDir,
      apply: true,
      applyProjects: [a],
    });
    if ('skipped' in out) throw new Error(out.skipped);
    const { record } = out;
    expect(record.mode).toBe('apply');
    expect(existsSync(paths.T1 ?? '')).toBe(false);
    for (const id of ['T2', 'T3', 'T4', 'T5', 'stray'])
      expect(existsSync(paths[id] ?? '')).toBe(true);
    const removed = record.rows.filter((r) => r.removed);
    expect(removed.map((r) => r.path)).toEqual([paths.T1]);
    expect(record.reclaimedApparentBytes).toBe(removed[0]?.apparentBytes);
    expect(record.reclaimedApparentBytes).toBeGreaterThan(0);
    expect(typeof record.dfFreeBefore).toBe('number');
    expect(typeof record.dfDelta).toBe('number');
    expect(record.counts.redundant).toBe(1); // B's T4: report only
  });

  it('never runs while another census holds the lock', async () => {
    mkdirSync(recordDir, { recursive: true });
    const release = acquireHeartbeatLock(join(recordDir, 'census.lock'), 60_000);
    try {
      expect(await runWorktreeCensus({ projects: [a], recordDir })).toEqual({
        skipped: 'another census holds the lock',
      });
    } finally {
      release?.();
    }
  });

  it('the lazy spawn claims at most one census per 24 h, never in CI, vitest or a git hook', () => {
    const now = Date.now();
    expect(claimCensus(now, recordDir)).toBe(true);
    expect(claimCensus(now + 60_000, recordDir)).toBe(false);
    expect(claimCensus(now + CENSUS_INTERVAL_MS + 1, recordDir)).toBe(true);
    expect(claimCensus(now, recordDir, a)).toBe(true);
    expect(claimCensus(now, recordDir, b)).toBe(true);
    expect(claimCensus(now + 60_000, recordDir, a)).toBe(false);
    expect(censusSpawnAllowed({})).toBe(true);
    expect(censusSpawnAllowed({ CI: 'true' })).toBe(false);
    expect(censusSpawnAllowed({ VITEST: 'true' })).toBe(false);
    for (const k of ['GIT_DIR', 'GIT_INDEX_FILE', 'GIT_EXEC_PATH']) {
      expect(censusSpawnAllowed({ [k]: '/x' })).toBe(false);
    }
  });

  it('reads the registered projects from the registry listing; an unreadable registry is none', async () => {
    expect(await registeredProjects(async () => [{ path: '/p/a' }, { path: '/p/b' }])).toEqual([
      '/p/a',
      '/p/b',
    ]);
    expect(
      await registeredProjects(async () => {
        throw new Error('no registry');
      }),
    ).toEqual([]);
  });

  it('the spawn guard refuses while the lock is held; a stale lock is reclaimed', async () => {
    mkdirSync(recordDir, { recursive: true });
    const spawned: string[][] = [];
    const spawn = (cmd: string, args: string[]) => {
      spawned.push([cmd, ...args]);
      return { unref: () => undefined };
    };
    const release = acquireHeartbeatLock(join(recordDir, 'census.lock'), 60_000);
    try {
      expect(startLazyCensus({}, { spawn, dir: recordDir })).toBe('another census holds the lock');
      expect(spawned).toEqual([]);
    } finally {
      release?.();
    }
    // A lock left by a dead census, heartbeat long past: reclaimed.
    writeFileSync(join(recordDir, 'census.lock'), 'dead');
    const old = new Date(Date.now() - 60 * 60 * 1000);
    utimesSync(join(recordDir, 'census.lock'), old, old);
    expect(startLazyCensus({}, { spawn, dir: recordDir })).toBeNull();
    expect(spawned).toHaveLength(1);
    expect(spawned[0]?.join(' ')).toContain('runLazyCensus');
    const out = await runWorktreeCensus({ projects: [a], recordDir });
    expect('skipped' in out).toBe(false);
    expect(existsSync(join(recordDir, 'census.lock'))).toBe(false); // released
  });

  it('a spent wall-clock budget writes a partial record instead of hanging', async () => {
    const out = await runWorktreeCensus({ projects: [a, b], recordDir, deadline: Date.now() - 1 });
    if ('skipped' in out) throw new Error(out.skipped);
    expect(out.record.partial).toBe(true);
    expect(JSON.parse(readFileSync(out.recordPath, 'utf-8')).partial).toBe(true);
  });

  it('sizes with lstat only: a symlink to a large tree counts as the link', () => {
    const big = join(base, 'big');
    mkdirSync(big);
    writeFileSync(join(big, 'f'), 'x'.repeat(100_000));
    const holder = join(base, 'holder');
    mkdirSync(holder);
    symlinkSync(big, join(holder, 'node_modules'));
    expect(apparentBytes(holder)).toBeLessThan(10_000);
  });
});
