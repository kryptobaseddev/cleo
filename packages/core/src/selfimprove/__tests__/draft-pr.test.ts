/**
 * Tests for the draft-PR egress (T11889-C · T11913).
 *
 * Proves the self-dogfooding egress contract:
 *  - dry-run is the DEFAULT (no git/gh invoked); the planned `gh pr create` step
 *    carries `--draft` and `--base main`, on a `feat/T11889-…` branch;
 *  - no step pushes `main`;
 *  - the live path appends `--draft` to the real `gh pr create` argv (mocked
 *    runner) and NEVER auto-merges / publishes;
 *  - missing / empty patch ⇒ typed error.
 *
 * @epic T11889
 * @task T11913
 */

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { type CommandRunner, draftPrBranchName, openDraftPr } from '../draft-pr.js';

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
  });
});

describe('openDraftPr — live (mocked runner)', () => {
  it('passes --draft to gh pr create and returns the PR url; never auto-merges', async () => {
    const patch = join(dir, 'fix.patch');
    writeFileSync(patch, 'diff --git a/x b/x\n');

    const ghArgv: string[][] = [];
    const run = vi.fn<CommandRunner>((file, args) => {
      if (file === 'gh' && args[0] === 'pr') {
        ghArgv.push([...args]);
        return 'https://github.com/o/r/pull/42\n';
      }
      if (file === 'gh') return 'gh version 2.x';
      return '';
    });

    const res = await openDraftPr({
      scenario: 'scen',
      diffPath: patch,
      title: 'fix',
      body: 'body',
      cwd: dir,
      execute: true,
      run,
      timestamp: () => 'TS',
    });

    expect(res.kind).toBe('ok');
    if (res.kind !== 'ok') throw new Error('expected ok');
    expect(res.prUrl).toBe('https://github.com/o/r/pull/42');
    // The gh pr create argv includes --draft and --base main, never --merge/auto.
    expect(ghArgv[0]).toContain('--draft');
    expect(ghArgv[0]).toContain('--base');
    expect(ghArgv[0]).toContain('main');
    expect(ghArgv[0]).not.toContain('--merge');
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
