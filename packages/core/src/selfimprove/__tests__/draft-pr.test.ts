/**
 * Tests for the draft-PR egress (T11889-C · T11913 · T12007).
 *
 * Proves the self-dogfooding egress contract:
 *  - dry-run is the DEFAULT (no git/gh invoked); the planned `gh pr create` step
 *    carries `--draft` and `--base main`, on a `feat/T11889-…` branch;
 *  - no step pushes `main`;
 *  - the live path appends `--draft` to the real `gh pr create` argv (mocked
 *    runner) and NEVER auto-merges / publishes;
 *  - missing / empty patch ⇒ typed error;
 *  - **workspace isolation (T12007):** every git mutation runs INSIDE the
 *    ephemeral worktree (never the invoking checkout), only the patch's paths
 *    are staged (never `git add -A`), and the orchestrator's untracked /
 *    uncommitted files survive untouched and are absent from the PR.
 *
 * @epic T11889
 * @task T11913
 * @task T12007
 */

import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  type CommandRunner,
  draftPrBranchName,
  openDraftPr,
  parseUnifiedDiffPaths,
} from '../draft-pr.js';

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'draft-pr-'));
});

afterEach(() => {
  try {
    rmSync(dir, { recursive: true, force: true });
  } catch {
    /* best-effort */
  }
});

describe('draftPrBranchName', () => {
  it('produces a sanitized feat/T11889 branch', () => {
    const b = draftPrBranchName('dhq-replay-find', '2026-06-08T00:00:00.000Z');
    expect(b).toBe('feat/T11889-selfimprove-dhq-replay-find-2026-06-08T00-00-00-000Z');
  });
});

describe('parseUnifiedDiffPaths (T12007)', () => {
  it('extracts modified paths from a diff --git header', () => {
    const patch =
      'diff --git a/packages/core/src/x.ts b/packages/core/src/x.ts\n' +
      '--- a/packages/core/src/x.ts\n' +
      '+++ b/packages/core/src/x.ts\n' +
      '@@ -1 +1 @@\n-a\n+b\n';
    expect(parseUnifiedDiffPaths(patch)).toEqual(['packages/core/src/x.ts']);
  });

  it('skips /dev/null on pure adds and captures the new path', () => {
    const patch = 'diff --git a/new.ts b/new.ts\n--- /dev/null\n+++ b/new.ts\n@@ -0,0 +1 @@\n+x\n';
    expect(parseUnifiedDiffPaths(patch)).toEqual(['new.ts']);
  });

  it('captures BOTH sides of a rename', () => {
    const patch = 'diff --git a/old.ts b/new.ts\nrename from old.ts\nrename to new.ts\n';
    expect(parseUnifiedDiffPaths(patch)).toEqual(['old.ts', 'new.ts']);
  });

  it('de-duplicates and returns empty for prose', () => {
    expect(parseUnifiedDiffPaths('I could not find the bug, sorry.')).toEqual([]);
  });
});

describe('openDraftPr — dry-run (default)', () => {
  it('returns steps with --draft / --base main and no main push, without invoking the runner', async () => {
    const patch = join(dir, 'fix.patch');
    writeFileSync(patch, 'diff --git a/x b/x\n');
    const run = vi.fn<CommandRunner>(() => '');

    const res = await openDraftPr({
      scenario: 'scen',
      diffPath: patch,
      title: 'fix',
      body: 'body',
      cwd: dir,
      run,
      timestamp: () => '2026-06-08T00:00:00.000Z',
    });

    expect(res.kind).toBe('dry-run');
    if (res.kind !== 'dry-run') throw new Error('expected dry-run');
    expect(run).not.toHaveBeenCalled();
    const ghStep = res.steps.find((s) => s.startsWith('gh pr create'));
    expect(ghStep).toContain('--draft');
    expect(ghStep).toContain('--base main');
    expect(res.branchName).toBe('feat/T11889-selfimprove-scen-2026-06-08T00-00-00-000Z');
    expect(res.steps.some((s) => /push\s+-u\s+origin\s+main\b/.test(s))).toBe(false);
    // T12007: the plan stages ONLY the patch's paths, never `git add -A`.
    expect(res.patchPaths).toEqual(['x']);
    expect(res.steps.some((s) => /git add -A/.test(s))).toBe(false);
    expect(res.steps.some((s) => s.includes('add -- x'))).toBe(true);
  });
});

describe('openDraftPr — live (mocked runner + injected worktree)', () => {
  it('runs every git mutation inside the worktree, stages only patch paths, never touches main', async () => {
    const patch = join(dir, 'fix.patch');
    writeFileSync(patch, 'diff --git a/a.ts b/a.ts\n--- a/a.ts\n+++ b/a.ts\n@@ -1 +1 @@\n-1\n+2\n');
    const worktreeDir = join(dir, 'wt');

    const calls: Array<{ file: string; args: readonly string[]; cwd?: string }> = [];
    const ghArgv: string[][] = [];
    const run = vi.fn<CommandRunner>((file, args, cwd) => {
      calls.push({ file, args, cwd });
      if (file === 'gh' && args[0] === 'pr') {
        ghArgv.push([...args]);
        return 'https://github.com/o/r/pull/42\n';
      }
      if (file === 'gh') return 'gh version 2.x';
      return '';
    });

    const provisioned: string[] = [];
    const removed: string[] = [];

    const res = await openDraftPr({
      scenario: 'scen',
      diffPath: patch,
      title: 'fix',
      body: 'body',
      cwd: dir,
      execute: true,
      run,
      worktreeDir,
      provisionWorktree: (o) => {
        provisioned.push(o.worktreePath);
        expect(o.baseRef).toBe('origin/main');
        expect(o.projectRoot).toBe(dir);
      },
      removeWorktree: (_root, p) => {
        removed.push(p);
      },
      timestamp: () => 'TS',
    });

    expect(res.kind).toBe('ok');
    if (res.kind !== 'ok') throw new Error('expected ok');
    expect(res.prUrl).toBe('https://github.com/o/r/pull/42');
    expect(res.patchPaths).toEqual(['a.ts']);

    // The worktree was provisioned and torn down.
    expect(provisioned).toEqual([worktreeDir]);
    expect(removed).toEqual([worktreeDir]);

    // gh pr create argv includes --draft/--base main, never --merge/auto.
    expect(ghArgv[0]).toContain('--draft');
    expect(ghArgv[0]).toContain('--base');
    expect(ghArgv[0]).toContain('main');
    expect(ghArgv[0]).not.toContain('--merge');

    // T12007: apply/add/commit/push all run INSIDE the worktree, never cwd=dir.
    const gitMutations = calls.filter(
      (c) => c.file === 'git' && ['apply', 'add', 'commit', 'push'].includes(c.args[0]),
    );
    expect(gitMutations.length).toBe(4);
    for (const c of gitMutations) expect(c.cwd).toBe(worktreeDir);

    // T12007: staging is `git add -- a.ts`, NEVER `git add -A`.
    const addCall = calls.find((c) => c.file === 'git' && c.args[0] === 'add');
    expect(addCall?.args).toEqual(['add', '--', 'a.ts']);
    expect(calls.some((c) => c.file === 'git' && c.args.includes('-A'))).toBe(false);

    // The only `git` call against the invoking checkout is the read-only fetch.
    const cwdDirGit = calls.filter((c) => c.file === 'git' && c.cwd === dir);
    expect(cwdDirGit.every((c) => c.args[0] === 'fetch')).toBe(true);

    // No `git push … main` was ever run.
    const pushedMain = run.mock.calls.some(
      ([file, args]) => file === 'git' && args[0] === 'push' && args.includes('main'),
    );
    expect(pushedMain).toBe(false);
  });

  it('returns E_NOT_FOUND for a missing patch', async () => {
    const res = await openDraftPr({
      scenario: 'scen',
      diffPath: join(dir, 'nope.patch'),
      title: 't',
      body: 'b',
      cwd: dir,
    });
    expect(res.kind).toBe('error');
    if (res.kind === 'error') expect(res.code).toBe('E_NOT_FOUND');
  });
});

/**
 * The AC4 regression: a REAL git workspace with a bare `origin`, a seeded
 * untracked owner file, and an uncommitted edit to a tracked file. Proves the
 * egress isolates in a clean worktree — the untracked file survives on disk,
 * stays untracked in the workspace, and is ABSENT from the pushed branch, which
 * contains ONLY the patch's path off origin/main.
 */
describe('openDraftPr — isolation against a real dirty checkout (T12007 AC1-AC4)', () => {
  const git = (cwd: string, ...args: string[]): string =>
    execFileSync('git', args, { cwd, stdio: 'pipe' }).toString('utf8');

  let origin: string;
  let work: string;

  beforeEach(() => {
    origin = mkdtempSync(join(tmpdir(), 'sip-origin-'));
    work = mkdtempSync(join(tmpdir(), 'sip-work-'));
    git(origin, 'init', '--bare', '--initial-branch=main', '.');
    git(work, 'init', '--initial-branch=main', '.');
    git(work, 'config', 'user.email', 'test@example.com');
    git(work, 'config', 'user.name', 'Test');
    git(work, 'config', 'commit.gpgsign', 'false');
    writeFileSync(join(work, 'src.ts'), 'export const v = 1;\n');
    git(work, 'add', 'src.ts');
    git(work, 'commit', '-m', 'init');
    git(work, 'remote', 'add', 'origin', origin);
    git(work, 'push', '-u', 'origin', 'main');
  });

  afterEach(() => {
    for (const d of [origin, work]) {
      try {
        rmSync(d, { recursive: true, force: true });
      } catch {
        /* best-effort */
      }
    }
  });

  it('never sweeps the dirty workspace; PR carries only the patch path', async () => {
    // Seed an UNTRACKED owner scratch file (the class of file that was swept).
    mkdirSync(join(work, '.cleo', 'rcasd'), { recursive: true });
    const scratch = join(work, '.cleo', 'rcasd', 'scratch.md');
    const scratchBody = 'OWNER SCRATCH — must survive\n';
    writeFileSync(scratch, scratchBody);
    // And leave the tracked file dirty (uncommitted local edit).
    writeFileSync(join(work, 'src.ts'), 'export const v = 1;\n// local uncommitted edit\n');

    // The fix-gen patch: modifies src.ts, generated against origin/main state.
    const patch =
      'diff --git a/src.ts b/src.ts\n' +
      '--- a/src.ts\n' +
      '+++ b/src.ts\n' +
      '@@ -1 +1 @@\n' +
      '-export const v = 1;\n' +
      '+export const v = 2;\n';
    writeFileSync(join(work, 'fix.patch'), patch);

    // Real git for everything; mock ONLY gh (no network / no real PR).
    const run: CommandRunner = (file, args, cwd) => {
      if (file === 'gh' && args[0] === 'pr') return 'https://github.com/o/r/pull/99\n';
      if (file === 'gh') return 'gh version 2.x';
      return git(cwd ?? work, ...args);
    };

    const res = await openDraftPr({
      scenario: 'iso',
      diffPath: 'fix.patch',
      title: 'fix',
      body: 'body',
      cwd: work,
      execute: true,
      run,
      timestamp: () => 'TS',
    });

    expect(res.kind).toBe('ok');
    if (res.kind !== 'ok') throw new Error(`expected ok, got ${JSON.stringify(res)}`);
    const branch = res.branchName;

    // AC3/AC4: the untracked owner file survives on disk, byte-identical.
    expect(existsSync(scratch)).toBe(true);
    expect(readFileSync(scratch, 'utf8')).toBe(scratchBody);

    // AC3: the workspace is still exactly as dirty as we left it — the scratch
    // file is still untracked and src.ts still shows the uncommitted edit.
    const status = git(work, 'status', '--porcelain', '-uall');
    expect(status).toContain('?? .cleo/rcasd/scratch.md');
    expect(status).toContain(' M src.ts');

    // AC2: the invoking checkout is untouched — still on `main`, HEAD unmoved.
    expect(git(work, 'rev-parse', '--abbrev-ref', 'HEAD').trim()).toBe('main');

    // AC1/AC4: the pushed branch on origin contains ONLY src.ts, not scratch.
    const tree = git(origin, 'ls-tree', '-r', '--name-only', branch)
      .split('\n')
      .map((s) => s.trim())
      .filter(Boolean);
    expect(tree).toContain('src.ts');
    expect(tree.some((f) => f.includes('scratch'))).toBe(false);

    const changed = git(origin, 'diff', '--name-only', 'main', branch).trim();
    expect(changed).toBe('src.ts');

    // The branch's src.ts is the PATCH result (v=2 off origin/main), NOT the
    // local uncommitted edit that lived in the invoking checkout.
    const blob = git(origin, 'show', `${branch}:src.ts`);
    expect(blob).toContain('export const v = 2;');
    expect(blob).not.toContain('local uncommitted edit');
  });
});
