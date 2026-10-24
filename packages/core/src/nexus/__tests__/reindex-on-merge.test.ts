/**
 * Background reindex after a merge (T14010): opt-in, base branch only, one
 * at a time per project, lowest admission priority (never queued, yields to
 * waiters, gives up after its timeout), and only real outcomes recorded for
 * `cleo nexus status`. The attempt, clock, sleep and queue probe are
 * injected, so no real analysis or `cleo run` starts.
 *
 * @task T14010
 */

import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  REINDEX_ON_MERGE_GIT_KEY,
  REINDEX_ON_MERGE_LOCK_FILE,
  type ReindexOnMergeDeps,
  type ReindexRunner,
  readReindexOnMergeOutcome,
  runReindexOnMerge,
  setReindexOnMerge,
} from '../reindex-on-merge.js';

let root: string;

const git = (args: string[]): string =>
  execFileSync('git', args, {
    cwd: root,
    encoding: 'utf-8',
    stdio: ['ignore', 'pipe', 'ignore'],
  }).trim();

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

/** A runner answering `codes` in turn (last one repeats); `state.calls` counts attempts. */
function runner(...codes: (number | null)[]): ReindexRunner & { state: { calls: number } } {
  const state = { calls: 0 };
  const run: ReindexRunner = () => {
    const code = codes[Math.min(state.calls, codes.length - 1)] ?? null;
    state.calls++;
    return { exitCode: code, stderr: code === 0 ? '' : 'boom' };
  };
  return Object.assign(run, { state });
}

/** A fake clock that the injected sleep advances. */
function clock(): Required<Pick<ReindexOnMergeDeps, 'now' | 'sleep'>> & { slept: number[] } {
  let t = 1_000_000;
  const slept: number[] = [];
  return {
    now: () => t,
    sleep: async (ms) => {
      slept.push(ms);
      t += ms;
    },
    slept,
  };
}

describe('reindex on merge (T14010)', () => {
  it('does nothing unless enabled, and records nothing', async () => {
    const run = runner(0);
    const outcome = await runReindexOnMerge(root, { runner: run, queueBusy: () => false });
    expect(outcome).toMatchObject({
      outcome: 'skipped',
      reason: expect.stringContaining('enabled'),
    });
    expect(run.state.calls).toBe(0);
    expect(readReindexOnMergeOutcome(root)).toBeNull();
  });

  it('skips off the base branch without recording over the last real outcome', async () => {
    configure({ enabled: true });
    await runReindexOnMerge(root, { runner: runner(0), queueBusy: () => false });
    git(['switch', '-q', '-c', 'feature']);
    const run = runner(0);
    const skipped = await runReindexOnMerge(root, { runner: run, queueBusy: () => false });
    expect(skipped.outcome).toBe('skipped');
    expect(run.state.calls).toBe(0);
    expect(readReindexOnMergeOutcome(root)?.outcome).toBe('ran');
  });

  it('runs once admitted, and releases the lock', async () => {
    configure({ enabled: true });
    const run = runner(0);
    const outcome = await runReindexOnMerge(root, { runner: run, queueBusy: () => false });
    expect(outcome.outcome).toBe('ran');
    expect(run.state.calls).toBe(1);
    expect(existsSync(join(root, '.cleo', REINDEX_ON_MERGE_LOCK_FILE))).toBe(false);
  });

  it('never queues: yields to waiters, retries a deferral, gives up at its timeout', async () => {
    configure({ enabled: true, timeoutSeconds: 120 });
    const time = clock();
    let waiting = 2;
    const run = runner(75);
    const outcome = await runReindexOnMerge(root, {
      runner: run,
      ...time,
      queueBusy: () => waiting-- > 0,
    });
    expect(outcome.outcome).toBe('deferred');
    // Two passes yielded to waiters, then attempts until 120s ran out.
    expect(run.state.calls).toBeGreaterThan(0);
    expect(time.slept.every((ms) => ms === 30_000)).toBe(true);
    expect(time.slept.reduce((a, b) => a + b, 0)).toBeLessThanOrEqual(120_000);
    expect(readReindexOnMergeOutcome(root)?.outcome).toBe('deferred');
  });

  it('defaults to a 300s budget and records a failure with its stderr', async () => {
    configure({ enabled: true });
    const time = clock();
    const deferred = await runReindexOnMerge(root, {
      runner: runner(75),
      ...time,
      queueBusy: () => false,
    });
    expect(deferred.reason).toContain('300s');
    const failed = await runReindexOnMerge(root, { runner: runner(1), queueBusy: () => false });
    expect(failed).toMatchObject({ outcome: 'failed', reason: expect.stringContaining('boom') });
  });

  it('never runs twice at once: a live or still-writing holder skips, a dead one is cleared', async () => {
    configure({ enabled: true });
    const lock = join(root, '.cleo', REINDEX_ON_MERGE_LOCK_FILE);
    writeFileSync(lock, String(process.pid));
    const run = runner(0);
    expect(
      (await runReindexOnMerge(root, { runner: run, queueBusy: () => false })).reason,
    ).toContain('already running');
    // An empty lock is a holder still writing it, not a dead one.
    writeFileSync(lock, '');
    expect((await runReindexOnMerge(root, { runner: run, queueBusy: () => false })).outcome).toBe(
      'skipped',
    );
    expect(run.state.calls).toBe(0);

    writeFileSync(lock, '999999999');
    expect((await runReindexOnMerge(root, { runner: run, queueBusy: () => false })).outcome).toBe(
      'ran',
    );
    expect(run.state.calls).toBe(1);
  });

  it('--enable sets the config and the git marker; --disable clears both', async () => {
    await setReindexOnMerge(root, true);
    expect(git(['config', '--bool', '--get', REINDEX_ON_MERGE_GIT_KEY])).toBe('true');
    await setReindexOnMerge(root, false);
    expect(() => git(['config', '--get', REINDEX_ON_MERGE_GIT_KEY])).toThrow();
    await setReindexOnMerge(root, false);
  });
});
