/**
 * Tests for scripts/ci-phantom-cancel-watchdog.mjs (T12103, T14488).
 *
 * Covers the phantom-cancel detection signature, the superseded-run guards
 * (same-sha attempts, a moved ref head, PR/branch identity), the head
 * resolution through the REAL resolver with an injected `gh` fetch, the
 * "unknown head means skip" rule, the 7-day age guard, dry-run mutation
 * safety, and a replay of the 2026-11-11 #2788 phantom re-run. All `gh`
 * interaction is dependency-injected via a fake exec function — no network, no
 * CLI, and never a real rerun.
 *
 * @task T12103
 * @task T14488
 */

import { describe, expect, it } from 'vitest';
import {
  classifyHead,
  createHeadResolver,
  headIdentityOf,
  headTargetForRun,
  isLatestForTuple,
  isPhantomCancelJob,
  isPostJobCleanupStep,
  isSupersededByNewerHead,
  isWithinAgeWindow,
  MAX_AGE_DAYS,
  runWatchdog,
} from '../ci-phantom-cancel-watchdog.mjs';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const NOW = new Date('2026-08-20T12:00:00Z');
const REPO = 'kryptobaseddev/cleo';

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
    url: `https://github.com/${REPO}/actions/runs/1001`,
    event: 'push',
    headRepository: REPO,
    pullRequests: [],
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

/** Serialise an internal run fixture into the Actions-API run shape. */
function toApiRun(run) {
  return {
    id: run.databaseId,
    name: run.workflowName,
    workflow_id: run.workflowDatabaseId,
    head_branch: run.headBranch,
    head_sha: run.headSha,
    conclusion: run.conclusion,
    created_at: run.createdAt,
    run_number: run.number,
    html_url: run.url,
    event: run.event,
    head_repository: run.headRepository === null ? null : { full_name: run.headRepository },
    pull_requests: run.pullRequests.map((number) => ({ number })),
  };
}

/** Rerun targets recorded by the fake exec. */
function rerunIds(calls) {
  return calls.filter((c) => c[0] === 'run' && c[1] === 'rerun').map((c) => Number(c[2]));
}

/** Every `gh api` path the fake exec served or refused. */
function apiPaths(calls) {
  return calls.filter((c) => c[0] === 'api').map((c) => c[1]);
}

/**
 * Build a fake `gh` exec.
 *
 * - the Actions-API run list serves `runs` (completed runs)
 * - `gh run view` serves `jobsByRunId`, `gh run rerun` records the call
 * - ref-head lookups read `heads`, keyed `pulls/<number>` or
 *   `commits/<branch>`; a missing key THROWS, modelling an API error, a
 *   deleted branch or a permission problem
 * - `failures` forces a lookup to throw even when `heads` has the key
 */
function makeFakeExec({ runs = [], jobsByRunId = {}, heads = {}, failures = [], repo = REPO }) {
  const calls = [];
  const exec = (argv) => {
    calls.push(argv);
    if (argv[0] === 'api') {
      const path = argv[1];
      if (failures.some((needle) => path.includes(needle))) {
        throw new Error(`gh api failed: ${path}`);
      }
      if (path.startsWith(`repos/${repo}/actions/runs?`)) {
        return JSON.stringify({ workflow_runs: runs.map(toApiRun) });
      }
      const pull = /^repos\/([^/]+\/[^/]+)\/pulls\/(\d+)$/.exec(path);
      if (pull) {
        const sha = heads[`pulls/${pull[2]}`];
        if (!sha) throw new Error(`no pull head for ${pull[2]}`);
        return sha;
      }
      const commit = /^repos\/([^/]+\/[^/]+)\/commits\/(.+)$/.exec(path);
      if (commit) {
        const sha = heads[`commits/${commit[2]}`];
        if (!sha) throw new Error(`no branch head for ${commit[2]}`);
        return sha;
      }
      throw new Error(`unexpected api path: ${path}`);
    }
    if (argv[0] === 'run' && argv[1] === 'view') {
      return JSON.stringify({ jobs: jobsByRunId[Number(argv[2])] ?? [] });
    }
    if (argv[0] === 'run' && argv[1] === 'rerun') return '';
    if (argv[0] === 'repo' && argv[1] === 'view') return `${repo}\n`;
    throw new Error(`unexpected argv: ${argv.join(' ')}`);
  };
  return { exec, calls };
}

/** Phantom-cancel jobs for one run id. */
function phantomJobsFor(...ids) {
  return Object.fromEntries(
    ids.map((id) => [id, [makeJob('Unit Tests', 'cancelled', ALL_SUCCESS_STEPS)]]),
  );
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

describe('headTargetForRun', () => {
  it('resolves a pull_request run by PR number', () => {
    const run = makeRun({ event: 'pull_request', pullRequests: [2788] });
    expect(headTargetForRun(run)).toEqual({ kind: 'pull_request', pullRequestNumber: 2788 });
  });

  it('has no identity for a pull_request run without its PR number', () => {
    expect(headTargetForRun(makeRun({ event: 'pull_request', pullRequests: [] }))).toBeNull();
  });

  it('resolves a push run by its head repository and branch', () => {
    const run = makeRun({ event: 'push', headRepository: 'someone/cleo' });
    expect(headTargetForRun(run)).toEqual({
      kind: 'branch',
      repo: 'someone/cleo',
      branch: 'feat/x',
    });
  });

  it('treats pull_request_target as a branch run (it runs on the base branch)', () => {
    const run = makeRun({ event: 'pull_request_target', headBranch: 'main' });
    expect(headTargetForRun(run)).toEqual({ kind: 'branch', repo: REPO, branch: 'main' });
  });
});

describe('headIdentityOf', () => {
  it('keys PR runs by number and branch runs by head repo + branch', () => {
    expect(headIdentityOf(makeRun({ event: 'pull_request', pullRequests: [2788] }))).toBe(
      'pull_request:2788',
    );
    expect(headIdentityOf(makeRun({ headBranch: 'main', headRepository: 'someone/cleo' }))).toBe(
      'branch:someone/cleo#main',
    );
    expect(headIdentityOf(makeRun({ event: 'pull_request', pullRequests: [] }))).toBeNull();
  });
});

describe('isSupersededByNewerHead', () => {
  it('rejects an older-sha run when the same ref has a newer-sha run', () => {
    const older = makeRun({ databaseId: 1001, number: 5, headSha: 'aaa111' });
    const newer = makeRun({
      databaseId: 1002,
      number: 6,
      headSha: 'bbb222',
      conclusion: 'cancelled',
    });
    expect(isSupersededByNewerHead(older, [older, newer])).toBe(true);
  });

  it('accepts the current head of the ref', () => {
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

  it('does not supersede across two PRs that share a branch name', () => {
    // Same branch name, different PRs and forks: different refs, therefore
    // different concurrency groups (`refs/pull/<n>/merge`).
    const pr11 = makeRun({
      databaseId: 1001,
      number: 5,
      headSha: 'aaa111',
      event: 'pull_request',
      pullRequests: [11],
    });
    const pr12 = makeRun({
      databaseId: 1002,
      number: 6,
      headSha: 'bbb222',
      event: 'pull_request',
      pullRequests: [12],
    });
    expect(isSupersededByNewerHead(pr11, [pr11, pr12])).toBe(false);
    expect(isSupersededByNewerHead(pr12, [pr11, pr12])).toBe(false);
  });

  it('does not supersede when a PR run has no resolvable identity', () => {
    const unknown = makeRun({ databaseId: 1001, number: 5, event: 'pull_request' });
    const other = makeRun({ databaseId: 1002, number: 6, headSha: 'bbb222' });
    expect(isSupersededByNewerHead(unknown, [unknown, other])).toBe(false);
  });
});

describe('classifyHead', () => {
  const run = makeRun({ headBranch: 'task/T14440', headSha: 'aaa111' });

  it('is stale when the ref head moved to another sha', () => {
    expect(classifyHead(run, 'bbb222')).toBe('stale');
  });

  it('is current when the ref head matches', () => {
    expect(classifyHead(run, 'aaa111')).toBe('current');
  });

  it('is unknown (never rerun) when the head could not be resolved', () => {
    expect(classifyHead(run, null)).toBe('unknown');
    expect(classifyHead(run, '')).toBe('unknown');
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
// Head resolver (real resolver, injected `gh` fetch)
// ---------------------------------------------------------------------------

describe('createHeadResolver', () => {
  it('resolves a pull_request run from the pulls API, one cached call per PR', () => {
    const { exec, calls } = makeFakeExec({ heads: { 'pulls/2788': 'prhead' } });
    const resolve = createHeadResolver({ exec, repo: REPO });

    expect(resolve({ kind: 'pull_request', pullRequestNumber: 2788 })).toBe('prhead');
    expect(resolve({ kind: 'pull_request', pullRequestNumber: 2788 })).toBe('prhead');

    expect(apiPaths(calls)).toEqual([`repos/${REPO}/pulls/2788`]);
  });

  it('resolves a branch run from its own head repository, one cached call per branch', () => {
    const { exec, calls } = makeFakeExec({ heads: { 'commits/main': 'mainhead' } });
    const resolve = createHeadResolver({ exec, repo: REPO });

    const target = { kind: 'branch', repo: 'someone/cleo', branch: 'main' };
    expect(resolve(target)).toBe('mainhead');
    expect(resolve(target)).toBe('mainhead');

    expect(apiPaths(calls)).toEqual(['repos/someone/cleo/commits/main']);
  });

  it('keeps two PRs that share a branch name apart (one call per PR)', () => {
    const { exec, calls } = makeFakeExec({
      heads: { 'pulls/11': 'sha11', 'pulls/12': 'sha12' },
    });
    const resolve = createHeadResolver({ exec, repo: REPO });

    expect(resolve({ kind: 'pull_request', pullRequestNumber: 11 })).toBe('sha11');
    expect(resolve({ kind: 'pull_request', pullRequestNumber: 12 })).toBe('sha12');

    expect(apiPaths(calls)).toEqual([`repos/${REPO}/pulls/11`, `repos/${REPO}/pulls/12`]);
  });

  it('returns null (unknown) when the lookup errors, and does not retry it', () => {
    const { exec, calls } = makeFakeExec({
      heads: { 'pulls/2788': 'prhead' },
      failures: ['pulls/2788'],
    });
    const resolve = createHeadResolver({ exec, repo: REPO });

    expect(resolve({ kind: 'pull_request', pullRequestNumber: 2788 })).toBeNull();
    expect(resolve({ kind: 'pull_request', pullRequestNumber: 2788 })).toBeNull();

    expect(apiPaths(calls)).toEqual([`repos/${REPO}/pulls/2788`]);
  });
});

// ---------------------------------------------------------------------------
// runWatchdog integration (fake exec)
// ---------------------------------------------------------------------------

describe('runWatchdog', () => {
  it('reruns a phantom-cancelled run in execute mode', async () => {
    const runs = [makeRun({ databaseId: 1001 })];
    const { exec, calls } = makeFakeExec({
      runs,
      jobsByRunId: phantomJobsFor(1001),
      heads: { 'commits/feat/x': 'abc123' },
    });
    const summary = await runWatchdog({ exec, dryRun: false, limit: 30, now: NOW, repo: REPO });

    expect(summary.phantomRuns.map((p) => p.id)).toEqual([1001]);
    expect(summary.phantomRuns[0].phantomJobs).toEqual(['Unit Tests']);
    expect(summary.rerun).toEqual([1001]);
    expect(rerunIds(calls)).toEqual([1001]);
  });

  it('produces no mutations in dry-run mode', async () => {
    const runs = [makeRun({ databaseId: 1001 })];
    const { exec, calls } = makeFakeExec({
      runs,
      jobsByRunId: phantomJobsFor(1001),
      heads: { 'commits/feat/x': 'abc123' },
    });
    const summary = await runWatchdog({ exec, dryRun: true, limit: 30, now: NOW, repo: REPO });

    expect(summary.phantomRuns.map((p) => p.id)).toEqual([1001]);
    expect(summary.rerun).toEqual([]);
    expect(rerunIds(calls)).toEqual([]);
  });

  it('skips a cancelled run with a genuine failed step', async () => {
    const runs = [makeRun({ databaseId: 1001 })];
    const jobsByRunId = {
      1001: [makeJob('Test', 'cancelled', [makeStep('Test', 'failure')])],
    };
    const { exec, calls } = makeFakeExec({ runs, jobsByRunId });
    const summary = await runWatchdog({ exec, dryRun: false, limit: 30, now: NOW, repo: REPO });

    expect(summary.phantomRuns).toEqual([]);
    expect(summary.skippedNotPhantom).toEqual([1001]);
    expect(rerunIds(calls)).toEqual([]);
  });

  it('never resurrects a superseded run', async () => {
    const older = makeRun({ databaseId: 1001, number: 5 });
    const newer = makeRun({ databaseId: 1002, number: 6, conclusion: 'success' });
    const runs = [older, newer];
    const { exec, calls } = makeFakeExec({ runs, jobsByRunId: phantomJobsFor(1001) });
    const summary = await runWatchdog({ exec, dryRun: false, limit: 30, now: NOW, repo: REPO });

    expect(summary.skippedSuperseded).toEqual([1001]);
    expect(summary.rerun).toEqual([]);
    expect(rerunIds(calls)).toEqual([]);
  });

  it('skips runs older than the age window', async () => {
    const runs = [makeRun({ databaseId: 1001, createdAt: '2026-08-01T00:00:00Z' })];
    const { exec, calls } = makeFakeExec({
      runs,
      jobsByRunId: phantomJobsFor(1001),
      heads: { 'commits/feat/x': 'abc123' },
    });
    const summary = await runWatchdog({ exec, dryRun: false, limit: 30, now: NOW, repo: REPO });

    expect(summary.skippedTooOld).toEqual([1001]);
    expect(rerunIds(calls)).toEqual([]);
  });

  it('ignores non-cancelled runs entirely (no run view call)', async () => {
    const runs = [makeRun({ databaseId: 1001, conclusion: 'success' })];
    const { exec, calls } = makeFakeExec({ runs });
    const summary = await runWatchdog({ exec, dryRun: false, limit: 30, now: NOW, repo: REPO });

    expect(summary.cancelledRuns).toBe(0);
    expect(summary.phantomRuns).toEqual([]);
    expect(calls.some((c) => c[0] === 'run' && c[1] === 'view')).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Moved ref head (T14488): never rerun a stale sha on a live ref.
// ---------------------------------------------------------------------------

describe('runWatchdog — moved ref head (T14488)', () => {
  const branch = 'task/T14440';
  const staleSha = 'aaa111';
  const currentSha = 'bbb222';

  it('never reruns a run whose sha is not the ref head (older + newer run on one branch)', async () => {
    const stale = makeRun({ databaseId: 1001, number: 5, headBranch: branch, headSha: staleSha });
    const current = makeRun({
      databaseId: 1002,
      number: 6,
      headBranch: branch,
      headSha: currentSha,
    });
    const { exec, calls } = makeFakeExec({
      runs: [stale, current],
      jobsByRunId: phantomJobsFor(1001, 1002),
      heads: { [`commits/${branch}`]: currentSha },
    });

    const summary = await runWatchdog({
      exec,
      dryRun: false,
      limit: 30,
      now: NOW,
      repo: REPO,
    });

    expect(summary.skippedSuperseded).toEqual([1001]);
    expect(summary.phantomRuns.map((p) => p.id)).toEqual([1002]);
    expect(summary.rerun).toEqual([1002]);
    expect(rerunIds(calls)).toEqual([1002]);
    // One lookup for the one distinct ref — API calls stay bounded.
    expect(apiPaths(calls)).toEqual([
      `repos/${REPO}/actions/runs?status=completed&per_page=30`,
      `repos/${REPO}/commits/${branch}`,
    ]);
  });

  it('skips a stale head even when the newer run is not in the completed list', async () => {
    // The current-head run is still queued/in progress, so the completed run
    // list cannot prove the ref moved on — the resolved head must.
    const stale = makeRun({ databaseId: 1001, number: 5, headBranch: branch, headSha: staleSha });
    const { exec, calls } = makeFakeExec({
      runs: [stale],
      jobsByRunId: phantomJobsFor(1001),
      heads: { [`commits/${branch}`]: currentSha },
    });

    const summary = await runWatchdog({
      exec,
      dryRun: false,
      limit: 30,
      now: NOW,
      repo: REPO,
    });

    expect(summary.skippedSuperseded).toEqual([1001]);
    expect(summary.rerun).toEqual([]);
    expect(rerunIds(calls)).toEqual([]);
  });

  it('skips (never reruns) a run whose head lookup errors', async () => {
    // An API error, a deleted branch or a missing permission must not become
    // "not stale, rerun": the blind rerun is the exact harm T14488 fixes.
    const run = makeRun({ databaseId: 1001, number: 5, headBranch: branch, headSha: staleSha });
    const { exec, calls } = makeFakeExec({
      runs: [run],
      jobsByRunId: phantomJobsFor(1001),
      failures: [`commits/${branch}`],
    });

    const summary = await runWatchdog({
      exec,
      dryRun: false,
      limit: 30,
      now: NOW,
      repo: REPO,
    });

    expect(summary.skippedHeadUnknown).toEqual([1001]);
    expect(summary.skippedSuperseded).toEqual([]);
    expect(summary.phantomRuns).toEqual([]);
    expect(summary.rerun).toEqual([]);
    expect(rerunIds(calls)).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// PR identity (T14488, code review P2): a branch name is not a ref identity.
// ---------------------------------------------------------------------------

describe('runWatchdog — PR identity (T14488)', () => {
  const branch = 'task/shared';

  it('resolves a fork PR by PR number, not by the base repo branch of the same name', async () => {
    // The fork's `task/shared` head is `forkhead`; the base repo also has a
    // `task/shared` branch at `basecollision`. A branch-name lookup would call
    // this run stale (or another PR's head) and skip a re-run that is safe.
    const forkRun = makeRun({
      databaseId: 2001,
      number: 10,
      headBranch: branch,
      headSha: 'forkhead',
      event: 'pull_request',
      headRepository: 'contributor/cleo',
      pullRequests: [42],
    });
    const { exec, calls } = makeFakeExec({
      runs: [forkRun],
      jobsByRunId: phantomJobsFor(2001),
      heads: {
        'pulls/42': 'forkhead',
        [`commits/${branch}`]: 'basecollision',
      },
    });

    const summary = await runWatchdog({ exec, dryRun: false, limit: 30, now: NOW, repo: REPO });

    expect(summary.phantomRuns.map((p) => p.id)).toEqual([2001]);
    expect(summary.rerun).toEqual([2001]);
    expect(summary.skippedSuperseded).toEqual([]);
    // Only the PR's head was consulted — never the unrelated base branch.
    expect(apiPaths(calls).filter((p) => p.includes('/pulls/'))).toEqual([
      `repos/${REPO}/pulls/42`,
    ]);
    expect(apiPaths(calls).filter((p) => p.includes('/commits/'))).toEqual([]);
  });

  it('skips a pull_request run whose PR cannot be identified', async () => {
    const run = makeRun({
      databaseId: 2002,
      number: 11,
      headBranch: branch,
      event: 'pull_request',
      pullRequests: [],
    });
    const { exec, calls } = makeFakeExec({
      runs: [run],
      jobsByRunId: phantomJobsFor(2002),
    });

    const summary = await runWatchdog({ exec, dryRun: false, limit: 30, now: NOW, repo: REPO });

    expect(summary.skippedHeadUnknown).toEqual([2002]);
    expect(summary.rerun).toEqual([]);
    expect(rerunIds(calls)).toEqual([]);
  });

  it('keeps two PRs that share a branch name independent', async () => {
    // Two forks both use `task/shared`. Run 3001 belongs to PR 11, run 3002 to
    // PR 12. PR 12's newer run must not supersede PR 11's run (different
    // concurrency groups), and each head is checked once.
    const pr11 = makeRun({
      databaseId: 3001,
      number: 5,
      headBranch: branch,
      headSha: 'aaa111',
      event: 'pull_request',
      headRepository: 'alice/cleo',
      pullRequests: [11],
    });
    const pr12 = makeRun({
      databaseId: 3002,
      number: 6,
      headBranch: branch,
      headSha: 'bbb222',
      event: 'pull_request',
      headRepository: 'bob/cleo',
      pullRequests: [12],
    });
    const { exec, calls } = makeFakeExec({
      runs: [pr11, pr12],
      jobsByRunId: phantomJobsFor(3001, 3002),
      heads: { 'pulls/11': 'aaa111', 'pulls/12': 'bbb222' },
    });

    const summary = await runWatchdog({ exec, dryRun: false, limit: 30, now: NOW, repo: REPO });

    expect(summary.skippedSuperseded).toEqual([]);
    expect(summary.phantomRuns.map((p) => p.id)).toEqual([3001, 3002]);
    expect(summary.rerun).toEqual([3001, 3002]);
    expect(apiPaths(calls).filter((p) => p.includes('/pulls/'))).toEqual([
      `repos/${REPO}/pulls/11`,
      `repos/${REPO}/pulls/12`,
    ]);
  });
});

// ---------------------------------------------------------------------------
// Replay: the 2026-11-11 #2788 phantom re-run (T14488).
//
// The watchdog re-ran 42932816902 (stale head 6b26c850d, attempt 2 at
// 02:12Z). That re-run joined the shared `CI-refs/pull/2788/merge`
// concurrency group and GitHub cancelled 42941492356 — the PR's only run for
// its then-current head 07f926e8c ("Canceling since a higher priority waiting
// request ... exists"). A dry run over the same pair must now skip the stale
// run and leave the current-head run as the only rerun candidate.
// ---------------------------------------------------------------------------

const PR_2788_NOW = new Date('2026-11-11T02:12:00Z');
const PR_2788_BRANCH = 'task/T14440';
const PR_2788_STALE_SHA = '6b26c850d6b9ec34e1fafe10b9ea31edff443292';
const PR_2788_CURRENT_SHA = '07f926e8c7b63f7631e8d3ecb6c569a0d24f220f';

/** The recorded run pair, verbatim from `gh run view` + the Actions API. */
const PR_2788_RUNS = [
  makeRun({
    databaseId: 42932816902,
    number: 8171,
    workflowName: 'CI',
    workflowDatabaseId: 213594554,
    headBranch: PR_2788_BRANCH,
    headSha: PR_2788_STALE_SHA,
    createdAt: '2026-11-11T00:37:31Z',
    url: `https://github.com/${REPO}/actions/runs/42932816902`,
    event: 'pull_request',
    headRepository: REPO,
    pullRequests: [2788],
  }),
  makeRun({
    databaseId: 42941492356,
    number: 8176,
    workflowName: 'CI',
    workflowDatabaseId: 213594554,
    headBranch: PR_2788_BRANCH,
    headSha: PR_2788_CURRENT_SHA,
    createdAt: '2026-11-11T01:47:38Z',
    url: `https://github.com/${REPO}/actions/runs/42941492356`,
    event: 'pull_request',
    headRepository: REPO,
    pullRequests: [2788],
  }),
];

/** Both runs were cancelled by the concurrency group after all steps passed. */
const PR_2788_JOBS = {
  42932816902: [makeJob('Unit Tests (ubuntu-latest, shard 6)', 'cancelled', ALL_SUCCESS_STEPS)],
  42941492356: [makeJob('Unit Tests (ubuntu-latest, shard 3)', 'cancelled', ALL_SUCCESS_STEPS)],
};

describe('runWatchdog — 2026-11-11 #2788 replay (T14488)', () => {
  it('dry run skips the superseded 42932816902 and keeps the current head', async () => {
    const { exec, calls } = makeFakeExec({
      runs: PR_2788_RUNS,
      jobsByRunId: PR_2788_JOBS,
      heads: { 'pulls/2788': PR_2788_CURRENT_SHA },
    });

    const summary = await runWatchdog({
      exec,
      dryRun: true,
      limit: 30,
      now: PR_2788_NOW,
      repo: REPO,
    });

    expect(summary.scanned).toBe(2);
    expect(summary.cancelledRuns).toBe(2);
    // AC2: the stale run the watchdog re-ran on 2026-11-11 is reported skipped.
    expect(summary.skippedSuperseded).toEqual([42932816902]);
    expect(summary.phantomRuns.map((p) => p.id)).toEqual([42941492356]);
    expect(summary.rerun).toEqual([]);
    expect(rerunIds(calls)).toEqual([]);
    // The current-head run's freshness was proven through its PR, once.
    expect(apiPaths(calls).filter((p) => p.includes('/pulls/'))).toEqual([
      `repos/${REPO}/pulls/2788`,
    ]);
  });
});
