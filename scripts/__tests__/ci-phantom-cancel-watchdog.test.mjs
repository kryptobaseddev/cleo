/**
 * Tests for scripts/ci-phantom-cancel-watchdog.mjs (T12103, T14488).
 *
 * Covers the phantom-cancel detection signature, the superseded-run guards
 * (same-sha attempts, moved branch head, branch-head probe), the 7-day age
 * guard, dry-run mutation safety, and a replay of the 2026-11-11 #2788
 * phantom re-run. All `gh` interaction is dependency-injected via a fake exec
 * function — no network, no CLI, and never a real rerun.
 *
 * @task T12103
 * @task T14488
 */

import { describe, expect, it } from 'vitest';
import {
  isLatestForTuple,
  isPhantomCancelJob,
  isPostJobCleanupStep,
  isStaleBranchHead,
  isSupersededByNewerHead,
  isWithinAgeWindow,
  MAX_AGE_DAYS,
  runWatchdog,
} from '../ci-phantom-cancel-watchdog.mjs';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const NOW = new Date('2026-08-20T12:00:00Z');

function makeRun(overrides = {}) {
  return {
    databaseId: 1001,
    workflowName: 'CI',
    workflowDatabaseId: 10,
    headBranch: 'feat/x',
    headSha: 'abc123',
    conclusion: 'cancelled',
    createdAt: '2026-08-20T10:00:00Z',
    number: 5,
    url: 'https://github.com/kryptobaseddev/cleo/actions/runs/1001',
    ...overrides,
  };
}

function makeStep(name, conclusion) {
  return { name, conclusion };
}

function makeJob(name, conclusion, steps) {
  return { databaseId: 1, name, conclusion, steps };
}

const ALL_SUCCESS_STEPS = [
  makeStep('Checkout', 'success'),
  makeStep('Install', 'success'),
  makeStep('Test', 'success'),
  makeStep('Complete job', 'success'),
];

/**
 * Build a fake exec that serves `gh run list` from `runs` and `gh run view`
 * from `jobsByRunId`, and records every invocation. Rerun calls record into
 * `calls` but produce no output.
 */
function makeFakeExec({ runs, jobsByRunId }) {
  const calls = [];
  const exec = (argv) => {
    calls.push(argv);
    if (argv[0] === 'run' && argv[1] === 'list') return JSON.stringify(runs);
    if (argv[0] === 'run' && argv[1] === 'view') {
      const id = Number(argv[2]);
      return JSON.stringify({ jobs: jobsByRunId[id] ?? [] });
    }
    if (argv[0] === 'run' && argv[1] === 'rerun') return '';
    throw new Error(`unexpected argv: ${argv.join(' ')}`);
  };
  return { exec, calls };
}

// ---------------------------------------------------------------------------
// Phantom signature
// ---------------------------------------------------------------------------

describe('isPhantomCancelJob', () => {
  it('flags a cancelled job whose steps all succeeded', () => {
    expect(isPhantomCancelJob(makeJob('Reject Test', 'cancelled', ALL_SUCCESS_STEPS))).toBe(true);
  });

  it('treats skipped steps as benign', () => {
    const steps = [...ALL_SUCCESS_STEPS, makeStep('Deploy', 'skipped')];
    expect(isPhantomCancelJob(makeJob('CI', 'cancelled', steps))).toBe(true);
  });

  it('exempts post-job cleanup steps from the all-success rule', () => {
    const steps = [...ALL_SUCCESS_STEPS, makeStep('Post Run actions/checkout@v4', 'cancelled')];
    expect(isPhantomCancelJob(makeJob('CI', 'cancelled', steps))).toBe(true);
  });

  it('rejects a genuine mid-step cancel (failed step)', () => {
    const steps = [makeStep('Checkout', 'success'), makeStep('Test', 'failure')];
    expect(isPhantomCancelJob(makeJob('CI', 'cancelled', steps))).toBe(false);
  });

  it('rejects a genuine mid-step cancel (cancelled step)', () => {
    const steps = [makeStep('Checkout', 'success'), makeStep('Test', 'cancelled')];
    expect(isPhantomCancelJob(makeJob('CI', 'cancelled', steps))).toBe(false);
  });

  it('ignores jobs that did not conclude cancelled', () => {
    expect(isPhantomCancelJob(makeJob('CI', 'success', ALL_SUCCESS_STEPS))).toBe(false);
    expect(isPhantomCancelJob(makeJob('CI', 'failure', ALL_SUCCESS_STEPS))).toBe(false);
  });
});

describe('isPostJobCleanupStep', () => {
  it('matches GitHub post-step and complete-job names', () => {
    expect(isPostJobCleanupStep('Post Run actions/checkout@v4')).toBe(true);
    expect(isPostJobCleanupStep('Post Cache pnpm store')).toBe(true);
    expect(isPostJobCleanupStep('Complete job')).toBe(true);
    expect(isPostJobCleanupStep('Run tests')).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Guards
// ---------------------------------------------------------------------------

describe('isLatestForTuple', () => {
  it('accepts the newest run for its (workflow, branch, sha) tuple', () => {
    const older = makeRun({ databaseId: 1001, number: 5 });
    const newer = makeRun({ databaseId: 1002, number: 6 });
    expect(isLatestForTuple(newer, [older, newer])).toBe(true);
  });

  it('rejects a run superseded by a newer attempt of the same tuple', () => {
    const older = makeRun({ databaseId: 1001, number: 5 });
    const newer = makeRun({ databaseId: 1002, number: 6 });
    expect(isLatestForTuple(older, [older, newer])).toBe(false);
  });

  it('does not treat a different sha or workflow as superseding', () => {
    const run = makeRun({ databaseId: 1001, number: 5 });
    const otherSha = makeRun({ databaseId: 1002, number: 6, headSha: 'def456' });
    const otherWorkflow = makeRun({ databaseId: 1003, number: 7, workflowDatabaseId: 99 });
    expect(isLatestForTuple(run, [run, otherSha, otherWorkflow])).toBe(true);
  });
});

describe('isSupersededByNewerHead', () => {
  it('rejects an older-sha run when the same branch has a newer-sha run', () => {
    const older = makeRun({ databaseId: 1001, number: 5, headSha: 'aaa111' });
    const newer = makeRun({
      databaseId: 1002,
      number: 6,
      headSha: 'bbb222',
      conclusion: 'cancelled',
    });
    expect(isSupersededByNewerHead(older, [older, newer])).toBe(true);
  });

  it('accepts the current head of the branch', () => {
    const older = makeRun({ databaseId: 1001, number: 5, headSha: 'aaa111' });
    const newer = makeRun({
      databaseId: 1002,
      number: 6,
      headSha: 'bbb222',
      conclusion: 'cancelled',
    });
    expect(isSupersededByNewerHead(newer, [older, newer])).toBe(false);
  });

  it('leaves a newer attempt of the same sha to the tuple guard', () => {
    const older = makeRun({ databaseId: 1001, number: 5 });
    const newer = makeRun({ databaseId: 1002, number: 6 });
    expect(isSupersededByNewerHead(older, [older, newer])).toBe(false);
    expect(isLatestForTuple(older, [older, newer])).toBe(false);
  });

  it('does not supersede across branches or workflows', () => {
    const run = makeRun({ databaseId: 1001, number: 5, headSha: 'aaa111' });
    const otherBranch = makeRun({
      databaseId: 1002,
      number: 6,
      headBranch: 'feat/y',
      headSha: 'bbb222',
    });
    const otherWorkflow = makeRun({
      databaseId: 1003,
      number: 7,
      workflowDatabaseId: 99,
      headSha: 'ccc333',
    });
    expect(isSupersededByNewerHead(run, [run, otherBranch, otherWorkflow])).toBe(false);
  });
});

describe('isStaleBranchHead', () => {
  const run = makeRun({ headBranch: 'task/T14440', headSha: 'aaa111' });

  it('flags a run whose sha is no longer the branch head', () => {
    expect(isStaleBranchHead(run, new Map([['task/T14440', 'bbb222']]))).toBe(true);
  });

  it('accepts a run whose sha is the branch head', () => {
    expect(isStaleBranchHead(run, new Map([['task/T14440', 'aaa111']]))).toBe(false);
  });

  it('treats an unknown or unresolved head as not stale', () => {
    expect(isStaleBranchHead(run, new Map([['task/T14440', null]]))).toBe(false);
    expect(isStaleBranchHead(run, new Map())).toBe(false);
  });
});

describe('isWithinAgeWindow', () => {
  it('accepts a run inside the window and rejects one outside it', () => {
    expect(isWithinAgeWindow(makeRun({ createdAt: '2026-08-19T00:00:00Z' }), NOW)).toBe(true);
    expect(isWithinAgeWindow(makeRun({ createdAt: '2026-08-01T00:00:00Z' }), NOW)).toBe(false);
  });

  it(`window is ${MAX_AGE_DAYS} days`, () => {
    const edge = new Date(NOW.getTime() - MAX_AGE_DAYS * 24 * 60 * 60 * 1000).toISOString();
    expect(isWithinAgeWindow(makeRun({ createdAt: edge }), NOW)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// runWatchdog integration (fake exec)
// ---------------------------------------------------------------------------

describe('runWatchdog', () => {
  const phantomJobs = {
    1001: [makeJob('Reject Test', 'cancelled', ALL_SUCCESS_STEPS)],
  };

  it('reruns a phantom-cancelled run in execute mode', async () => {
    const runs = [makeRun({ databaseId: 1001 })];
    const { exec, calls } = makeFakeExec({ runs, jobsByRunId: phantomJobs });
    const summary = await runWatchdog({ exec, dryRun: false, limit: 30, now: NOW });

    expect(summary.phantomRuns.map((p) => p.id)).toEqual([1001]);
    expect(summary.phantomRuns[0].phantomJobs).toEqual(['Reject Test']);
    expect(summary.rerun).toEqual([1001]);
    expect(calls.some((c) => c[0] === 'run' && c[1] === 'rerun' && c[2] === '1001')).toBe(true);
  });

  it('produces no mutations in dry-run mode', async () => {
    const runs = [makeRun({ databaseId: 1001 })];
    const { exec, calls } = makeFakeExec({ runs, jobsByRunId: phantomJobs });
    const summary = await runWatchdog({ exec, dryRun: true, limit: 30, now: NOW });

    expect(summary.phantomRuns.map((p) => p.id)).toEqual([1001]);
    expect(summary.rerun).toEqual([]);
    expect(calls.some((c) => c[1] === 'rerun')).toBe(false);
  });

  it('skips a cancelled run with a genuine failed step', async () => {
    const runs = [makeRun({ databaseId: 1001 })];
    const jobsByRunId = {
      1001: [makeJob('Test', 'cancelled', [makeStep('Test', 'failure')])],
    };
    const { exec, calls } = makeFakeExec({ runs, jobsByRunId });
    const summary = await runWatchdog({ exec, dryRun: false, limit: 30, now: NOW });

    expect(summary.phantomRuns).toEqual([]);
    expect(summary.skippedNotPhantom).toEqual([1001]);
    expect(calls.some((c) => c[1] === 'rerun')).toBe(false);
  });

  it('never resurrects a superseded run', async () => {
    const older = makeRun({ databaseId: 1001, number: 5 });
    const newer = makeRun({ databaseId: 1002, number: 6, conclusion: 'success' });
    const runs = [older, newer];
    const { exec, calls } = makeFakeExec({ runs, jobsByRunId: phantomJobs });
    const summary = await runWatchdog({ exec, dryRun: false, limit: 30, now: NOW });

    expect(summary.skippedSuperseded).toEqual([1001]);
    expect(summary.rerun).toEqual([]);
    expect(calls.some((c) => c[1] === 'rerun')).toBe(false);
  });

  it('skips runs older than the age window', async () => {
    const runs = [makeRun({ databaseId: 1001, createdAt: '2026-08-01T00:00:00Z' })];
    const { exec, calls } = makeFakeExec({ runs, jobsByRunId: phantomJobs });
    const summary = await runWatchdog({ exec, dryRun: false, limit: 30, now: NOW });

    expect(summary.skippedTooOld).toEqual([1001]);
    expect(calls.some((c) => c[1] === 'rerun')).toBe(false);
  });

  it('ignores non-cancelled runs entirely (no run view call)', async () => {
    const runs = [makeRun({ databaseId: 1001, conclusion: 'success' })];
    const { exec, calls } = makeFakeExec({ runs, jobsByRunId: {} });
    const summary = await runWatchdog({ exec, dryRun: false, limit: 30, now: NOW });

    expect(summary.cancelledRuns).toBe(0);
    expect(summary.phantomRuns).toEqual([]);
    expect(calls.some((c) => c[1] === 'view')).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Moved branch head (T14488): never rerun a stale sha on a live branch.
// ---------------------------------------------------------------------------

/**
 * Build a branch-head lookup that records every branch it was asked about.
 *
 * @param {Record<string, string>} heads branch → head sha
 */
function makeHeadLookup(heads) {
  const asked = [];
  const resolve = (branch) => {
    asked.push(branch);
    return heads[branch] ?? null;
  };
  return { resolve, asked };
}

describe('runWatchdog — moved branch head (T14488)', () => {
  const branch = 'task/T14440';
  const staleSha = 'aaa111';
  const currentSha = 'bbb222';

  it('never reruns a run whose sha is not the branch head (older + newer run on one branch)', async () => {
    const stale = makeRun({ databaseId: 1001, number: 5, headBranch: branch, headSha: staleSha });
    const current = makeRun({
      databaseId: 1002,
      number: 6,
      headBranch: branch,
      headSha: currentSha,
    });
    const jobsByRunId = {
      1001: [makeJob('Unit Tests', 'cancelled', ALL_SUCCESS_STEPS)],
      1002: [makeJob('Unit Tests', 'cancelled', ALL_SUCCESS_STEPS)],
    };
    const { exec, calls } = makeFakeExec({ runs: [stale, current], jobsByRunId });
    const { resolve, asked } = makeHeadLookup({ [branch]: currentSha });

    const summary = await runWatchdog({
      exec,
      dryRun: false,
      limit: 30,
      now: NOW,
      resolveHeadSha: resolve,
    });

    expect(summary.skippedSuperseded).toEqual([1001]);
    expect(summary.phantomRuns.map((p) => p.id)).toEqual([1002]);
    expect(summary.rerun).toEqual([1002]);
    const reruns = calls.filter((c) => c[1] === 'rerun').map((c) => c[2]);
    expect(reruns).toEqual(['1002']);
    // One lookup for the one distinct branch — API calls stay bounded.
    expect(asked).toEqual([branch]);
  });

  it('skips a stale head even when the newer run is not in the completed list', async () => {
    // The current-head run is still queued/in progress, so `run list
    // --status completed` cannot prove the branch moved on — the head must.
    const stale = makeRun({ databaseId: 1001, number: 5, headBranch: branch, headSha: staleSha });
    const { exec, calls } = makeFakeExec({
      runs: [stale],
      jobsByRunId: { 1001: [makeJob('Unit Tests', 'cancelled', ALL_SUCCESS_STEPS)] },
    });
    const { resolve } = makeHeadLookup({ [branch]: currentSha });

    const summary = await runWatchdog({
      exec,
      dryRun: false,
      limit: 30,
      now: NOW,
      resolveHeadSha: resolve,
    });

    expect(summary.skippedSuperseded).toEqual([1001]);
    expect(summary.rerun).toEqual([]);
    expect(calls.some((c) => c[1] === 'rerun')).toBe(false);
  });

  it('reruns the head run when the branch head cannot be resolved but no newer run exists', async () => {
    const run = makeRun({ databaseId: 1001, number: 5, headBranch: branch, headSha: staleSha });
    const { exec } = makeFakeExec({
      runs: [run],
      jobsByRunId: { 1001: [makeJob('Unit Tests', 'cancelled', ALL_SUCCESS_STEPS)] },
    });
    const summary = await runWatchdog({
      exec,
      dryRun: false,
      limit: 30,
      now: NOW,
      resolveHeadSha: () => null,
    });

    expect(summary.skippedSuperseded).toEqual([]);
    expect(summary.rerun).toEqual([1001]);
  });
});

// ---------------------------------------------------------------------------
// Replay: the 2026-11-11 #2788 phantom re-run (T14488).
//
// The watchdog re-ran 42932816902 (stale head 6b26c850d, attempt 2 at
// 02:12Z). That re-run joined the shared `CI-refs/pull/2788/merge`
// concurrency group and GitHub cancelled 42941492356 — the PR's only run for
// its current head 07f926e8c ("Canceling since a higher priority waiting
// request ... exists"). A dry run over the same pair must now skip the stale
// run and leave the current-head run as the only rerun candidate.
// ---------------------------------------------------------------------------

const PR_2788_NOW = new Date('2026-11-11T02:12:00Z');
const PR_2788_BRANCH = 'task/T14440';
const PR_2788_STALE_SHA = '6b26c850d6b9ec34e1fafe10b9ea31edff443292';
const PR_2788_CURRENT_SHA = '07f926e8c7b63f7631e8d3ecb6c569a0d24f220f';

/** The recorded run pair, verbatim from `gh run view`. */
const PR_2788_RUNS = [
  makeRun({
    databaseId: 42932816902,
    number: 8171,
    workflowName: 'CI',
    workflowDatabaseId: 213594554,
    headBranch: PR_2788_BRANCH,
    headSha: PR_2788_STALE_SHA,
    createdAt: '2026-11-11T00:37:31Z',
    url: 'https://github.com/kryptobaseddev/cleo/actions/runs/42932816902',
  }),
  makeRun({
    databaseId: 42941492356,
    number: 8176,
    workflowName: 'CI',
    workflowDatabaseId: 213594554,
    headBranch: PR_2788_BRANCH,
    headSha: PR_2788_CURRENT_SHA,
    createdAt: '2026-11-11T01:47:38Z',
    url: 'https://github.com/kryptobaseddev/cleo/actions/runs/42941492356',
  }),
];

/** Both runs were cancelled by the concurrency group after all steps passed. */
const PR_2788_JOBS = {
  42932816902: [makeJob('Unit Tests (ubuntu-latest, shard 6)', 'cancelled', ALL_SUCCESS_STEPS)],
  42941492356: [makeJob('Unit Tests (ubuntu-latest, shard 3)', 'cancelled', ALL_SUCCESS_STEPS)],
};

describe('runWatchdog — 2026-11-11 #2788 replay (T14488)', () => {
  it('dry run skips the superseded 42932816902 and keeps the current head', async () => {
    const { exec, calls } = makeFakeExec({ runs: PR_2788_RUNS, jobsByRunId: PR_2788_JOBS });
    const { resolve } = makeHeadLookup({ [PR_2788_BRANCH]: PR_2788_CURRENT_SHA });

    const summary = await runWatchdog({
      exec,
      dryRun: true,
      limit: 30,
      now: PR_2788_NOW,
      resolveHeadSha: resolve,
    });

    expect(summary.scanned).toBe(2);
    expect(summary.cancelledRuns).toBe(2);
    // AC2: the stale run the watchdog re-ran on 2026-11-11 is reported skipped.
    expect(summary.skippedSuperseded).toEqual([42932816902]);
    expect(summary.phantomRuns.map((p) => p.id)).toEqual([42941492356]);
    expect(summary.rerun).toEqual([]);
    expect(calls.some((c) => c[1] === 'rerun')).toBe(false);
  });
});
