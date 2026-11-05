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
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { computeProjectHash, resolveWorktreeRootForHash } from '@cleocode/paths';
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
  CENSUS_INTERVAL_MS,
  censusBriefingLine,
  censusSpawnAllowed,
  claimCensus,
  runWorktreeCensus,
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
    expect(censusSpawnAllowed({})).toBe(true);
    expect(censusSpawnAllowed({ CI: 'true' })).toBe(false);
    expect(censusSpawnAllowed({ VITEST: 'true' })).toBe(false);
    for (const k of ['GIT_DIR', 'GIT_INDEX_FILE', 'GIT_EXEC_PATH']) {
      expect(censusSpawnAllowed({ [k]: '/x' })).toBe(false);
    }
  });
});
