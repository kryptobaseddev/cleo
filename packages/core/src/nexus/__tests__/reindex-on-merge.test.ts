/**
 * Background reindex after a merge (T14010): opt-in, base branch only, one
 * at a time per project, admitted by `cleo run`, with every outcome recorded
 * for `cleo nexus status`. The analysis itself is an injected runner, so no
 * real analysis or `cleo run` is started.
 *
 * @task T14010
 */

import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  REINDEX_ON_MERGE_LOCK_FILE,
  type ReindexRunner,
  readReindexOnMergeOutcome,
  runReindexOnMerge,
} from '../reindex-on-merge.js';

let root: string;

const git = (args: string[]): void => {
  execFileSync('git', args, { cwd: root, stdio: 'ignore' });
};

/** Write the project config's `nexus.reindexOnMerge`. */
function configure(reindexOnMerge: Record<string, unknown>): void {
  writeFileSync(join(root, '.cleo', 'config.json'), JSON.stringify({ nexus: { reindexOnMerge } }));
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'cleo-reindex-on-merge-'));
  mkdirSync(join(root, '.cleo'), { recursive: true });
  vi.stubEnv('CLEO_DIR', join(root, '.cleo'));
  vi.stubEnv('CLEO_ROOT', root);
  git(['init', '-q', '-b', 'main']);
  git(['config', 'user.name', 't']);
  git(['config', 'user.email', 't@example.com']);
  git(['config', 'commit.gpgsign', 'false']);
  writeFileSync(join(root, 'a.ts'), 'export const a = 1;\n');
  git(['add', 'a.ts']);
  git(['commit', '-q', '-m', 'init']);
});

afterEach(() => {
  vi.unstubAllEnvs();
  rmSync(root, { recursive: true, force: true });
});

/** A runner that records its calls and exits with `code`. */
function runner(code: number | null): ReindexRunner & { calls: number[] } {
  const calls: number[] = [];
  const run: ReindexRunner = (_root, timeout) => {
    calls.push(timeout);
    return { exitCode: code, stderr: code === 0 ? '' : 'boom' };
  };
  return Object.assign(run, { calls });
}

describe('reindex on merge (T14010)', () => {
  it('does nothing unless enabled, and records that it skipped', async () => {
    const run = runner(0);
    const outcome = await runReindexOnMerge(root, { runner: run });
    expect(outcome).toMatchObject({
      outcome: 'skipped',
      reason: expect.stringContaining('enabled'),
    });
    expect(run.calls).toEqual([]);
    expect(readReindexOnMergeOutcome(root)).toEqual(outcome);
  });

  it('skips off the base branch', async () => {
    configure({ enabled: true });
    git(['switch', '-q', '-c', 'feature']);
    const run = runner(0);
    const outcome = await runReindexOnMerge(root, { runner: run });
    expect(outcome.outcome).toBe('skipped');
    expect(outcome.reason).toContain('feature');
    expect(run.calls).toEqual([]);
  });

  it('runs on the base branch with the configured timeout and releases the lock', async () => {
    configure({ enabled: true, timeoutSeconds: 120 });
    const run = runner(0);
    const outcome = await runReindexOnMerge(root, { runner: run });
    expect(outcome.outcome).toBe('ran');
    expect(run.calls).toEqual([120]);
    expect(existsSync(join(root, '.cleo', REINDEX_ON_MERGE_LOCK_FILE))).toBe(false);
  });

  it('records a deferral when cleo run does not admit it, and a failure otherwise', async () => {
    configure({ enabled: true });
    expect((await runReindexOnMerge(root, { runner: runner(75) })).outcome).toBe('deferred');
    const failed = await runReindexOnMerge(root, { runner: runner(1) });
    expect(failed).toMatchObject({ outcome: 'failed', reason: expect.stringContaining('boom') });
    expect(readReindexOnMergeOutcome(root)?.outcome).toBe('failed');
  });

  it('never runs twice at once: a live holder skips, a dead one is cleared', async () => {
    configure({ enabled: true });
    const lock = join(root, '.cleo', REINDEX_ON_MERGE_LOCK_FILE);
    writeFileSync(lock, String(process.pid));
    const run = runner(0);
    const busy = await runReindexOnMerge(root, { runner: run });
    expect(busy).toMatchObject({
      outcome: 'skipped',
      reason: expect.stringContaining('already running'),
    });
    expect(run.calls).toEqual([]);
    expect(existsSync(lock)).toBe(true);

    writeFileSync(lock, '999999999');
    expect((await runReindexOnMerge(root, { runner: run })).outcome).toBe('ran');
    expect(run.calls).toHaveLength(1);
  });
});
