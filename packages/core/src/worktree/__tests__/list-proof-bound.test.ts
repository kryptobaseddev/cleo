/**
 * `cleo worktree list` proves each disposal candidate with ONE dependents scan
 * shared across the listing (T14554): every other checkout is read once per
 * listing, not once per proven worktree, and the categories stay the ones the
 * full proof gives (a worktree another checkout links into is still `keep`).
 *
 * Only the task store is stubbed (task statuses); git and the disk are real.
 *
 * @task T14554
 */

import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { DisposeWorktreeOptions, WorktreeDependentsScan } from '@cleocode/contracts';
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

const proofs: DisposeWorktreeOptions[] = [];
const scans: WorktreeDependentsScan[] = [];
vi.mock('@cleocode/worktree', async (importOriginal) => {
  const real = await importOriginal<typeof import('@cleocode/worktree')>();
  return {
    ...real,
    createWorktreeDependentsScan: () => {
      const scan = real.createWorktreeDependentsScan();
      scans.push(scan);
      return scan;
    },
    disposeWorktree: (opts: DisposeWorktreeOptions) => {
      proofs.push(opts);
      return real.disposeWorktree(opts);
    },
  };
});

import { listWorktrees } from '../list.js';

const git = (cwd: string, args: string[]): string =>
  execFileSync('git', args, { cwd, encoding: 'utf-8' }).trim();

const prevCleoHome = process.env['CLEO_HOME'];
let base: string;
let repo: string;

beforeEach(() => {
  base = realpathSync(mkdtempSync(join(tmpdir(), 'wt-list-bound-')));
  process.env['CLEO_HOME'] = join(base, 'cleo-home');
  repo = join(base, 'repo');
  mkdirSync(repo);
  git(repo, ['init', '-q', '-b', 'main']);
  writeFileSync(join(repo, '.gitignore'), 'node_modules\n');
  git(repo, ['add', '.']);
  git(repo, ['-c', 'user.name=T', '-c', 'user.email=t@e.x', 'commit', '-q', '-m', 'init']);
  TASKS.clear();
  proofs.length = 0;
  scans.length = 0;
});

afterEach(() => {
  if (prevCleoHome === undefined) delete process.env['CLEO_HOME'];
  else process.env['CLEO_HOME'] = prevCleoHome;
  rmSync(base, { recursive: true, force: true });
});

describe('worktree list bounds the disposal proof (T14554)', () => {
  it('reads each checkout once for the listing, and a linked-into worktree stays keep', async () => {
    const count = 8;
    const wts = join(base, 'wts');
    const paths: string[] = [];
    for (let i = 0; i < count; i++) {
      const id = `T7${i}`;
      const wt = join(wts, id);
      git(repo, ['worktree', 'add', '-q', '-b', `task/${id}`, wt]);
      mkdirSync(join(wt, 'node_modules', '.pnpm', `dep${i}@1.0.0`), { recursive: true });
      TASKS.set(id, 'done');
      paths.push(wt);
    }
    const owner = paths[0] as string;
    symlinkSync(
      join(owner, 'node_modules', '.pnpm', 'dep0@1.0.0'),
      join(paths[1] as string, 'node_modules', '.pnpm', 'shared@1.0.0'),
    );

    const result = await listWorktrees({ projectRoot: repo });
    if (!result.success) throw new Error(result.error.message);

    // Every finished worktree is proven, all with the one shared scan.
    expect(proofs).toHaveLength(count);
    expect(scans).toHaveLength(1);
    expect(proofs.every((p) => p.dryRun === true && p.dependentsScan === scans[0])).toBe(true);
    // Each checkout (8 worktrees + the main checkout) is read at most once.
    expect(scans[0]?.linkScans).toBeLessThanOrEqual(count + 1);

    const byPath = new Map(result.data.worktrees.map((w) => [w.path, w]));
    expect(byPath.get(owner)?.statusCategory).toBe('keep');
    expect(byPath.get(owner)?.keepReason).toContain('link(s) from other checkouts');
    for (const wt of paths.slice(1)) expect(byPath.get(wt)?.statusCategory).toBe('redundant');
  });
});
