/**
 * `ci:<pr>` — required CI on a merged PR satisfies testsPassed and qaPassed
 * (owner decision D11149, T12634).
 *
 * Pinned:
 *  1. every required check's latest run (per source and event) must be
 *     `completed`/`success` on the merge commit; pending, failed, cancelled,
 *     skipped and missing are each refused by name;
 *  2. a PR head's `pull_request` runs count only when its tree equals the
 *     merge tree AND the merge's first parent is an ancestor of the head;
 *  3. the atom is task-linked like `pr:` (title/body/branch or file scope);
 *  4. a pinned check only counts from its pinned app/workflow;
 *  5. each gate is attested by its declared `evidence.ciChecks` list, which
 *     must be configured and a subset of the required checks;
 *  6. opt-in only (`evidence.ciSatisfies`).
 *
 * @task T12634
 */

import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  type EvidenceAtom,
  type EvidenceValidationContext,
  PR_REQUIRED_WORKFLOWS_ENV_VAR,
  validateEvidenceForGate,
} from '@cleocode/contracts';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { checkTaskEvidenceContext, parseEvidence } from '../../tasks/evidence.js';
import {
  type CommitCheck,
  ciSatisfiesRemedy,
  evaluateMergeCommitChecks,
  hasIncompleteIdentity,
  inheritedOnMerge,
  isQuarantineBudgetOnlyLog,
  isRunnerCancelOnlyLog,
  isSetupStepFailureLog,
  isWorkerCrashOnlyLog,
  listMainDescendants,
  listPathTouchingMainCommits,
  pathGlobToRegExp,
  type ResolveCiEvidenceOptions,
  readCiChecks,
  readCiSatisfies,
  recheckCiDescendantAtom,
  resolveCiEvidenceAtom,
} from '../ci-evidence.js';
import type { PrAtomResolution } from '../pr-evidence.js';

const MERGE = 'a'.repeat(40);
const HEAD = 'b'.repeat(40);
const PARENT = 'e'.repeat(40);
const TREE = 'c'.repeat(40);
const REQUIRED = ['CI', 'Lockfile Check', 'Contracts Dep Lint'];

function check(name: string, extra: Partial<CommitCheck> = {}): CommitCheck {
  return {
    name,
    source: 'check-run',
    status: 'completed',
    conclusion: 'success',
    headSha: MERGE,
    id: 1,
    appSlug: 'github-actions',
    event: 'push',
    ...extra,
  };
}

const allGreen: CommitCheck[] = [
  check('CI', { source: 'workflow-run', workflowPath: '.github/workflows/ci.yml' }),
  check('CI', { id: 2, workflowPath: '.github/workflows/ci.yml' }),
  check('Lockfile Check', {
    source: 'workflow-run',
    workflowPath: '.github/workflows/lockfile-check.yml',
  }),
  check('Contracts Dep Lint', { workflowPath: '.github/workflows/ci.yml' }),
  check('Type Check', { workflowPath: '.github/workflows/ci.yml' }),
  check('Lint & Format', { workflowPath: '.github/workflows/ci.yml' }),
  check('Unit Tests (ubuntu-latest, shard 1)', { workflowPath: '.github/workflows/ci.yml' }),
  check('Unit Tests (ubuntu-latest, shard 2)', { workflowPath: '.github/workflows/ci.yml' }),
];

/** Every mapped check pinned to github-actions and its workflow file. */
const PINNED = {
  release: {
    prRequiredWorkflows: [
      { name: 'CI', app: 'github-actions', workflow: '.github/workflows/ci.yml' },
      {
        name: 'Lockfile Check',
        app: 'github-actions',
        workflow: '.github/workflows/lockfile-check.yml',
      },
      { name: 'Contracts Dep Lint', app: 'github-actions', workflow: '.github/workflows/ci.yml' },
    ],
  },
};
const onHead = allGreen.map((c) => ({ ...c, headSha: HEAD, event: 'pull_request' }));

function context(
  taskId = 'T1',
  gates: EvidenceValidationContext['gates'] = ['testsPassed'],
): EvidenceValidationContext {
  return {
    task: { id: taskId, kind: 'work', labels: [], files: [], acceptance: [] },
    gates,
    criteria: [],
  };
}

describe('evaluateMergeCommitChecks', () => {
  it('accepts when every required check succeeded on the merge commit', () => {
    const r = evaluateMergeCommitChecks(REQUIRED, allGreen, MERGE);
    expect(r.ok).toBe(true);
    expect(r.ok && r.checks.map((c) => c.name).sort()).toEqual(REQUIRED.toSorted());
  });

  it.each([
    ['pending', { status: 'in_progress', conclusion: null }, /Lockfile Check.*pending/],
    ['failed', { conclusion: 'failure' }, /Lockfile Check.*failure/],
    ['cancelled', { conclusion: 'cancelled' }, /Lockfile Check.*cancelled/],
    ['skipped', { conclusion: 'skipped' }, /Lockfile Check.*skipped/],
  ] as const)('refuses a %s required check, naming it', (_label, patch, reason) => {
    const checks = allGreen.map((c) => (c.name === 'Lockfile Check' ? { ...c, ...patch } : c));
    const r = evaluateMergeCommitChecks(REQUIRED, checks, MERGE);
    expect(r.ok).toBe(false);
    expect(!r.ok && r.reasons.join('\n')).toMatch(reason);
  });

  it('refuses a missing required check', () => {
    const r = evaluateMergeCommitChecks(
      REQUIRED,
      allGreen.filter((c) => c.name !== 'Contracts Dep Lint'),
      MERGE,
    );
    expect(!r.ok && r.reasons.join('\n')).toMatch(/Contracts Dep Lint.*not found on merge commit/);
  });

  it('never counts a check that ran on another SHA unless it is the tree-equivalent head', () => {
    const r = evaluateMergeCommitChecks(REQUIRED, onHead, MERGE);
    expect(!r.ok && r.reasons.join('\n')).toMatch(
      new RegExp(`CI.*ran on ${HEAD.slice(0, 12)}, not the merge commit ${MERGE.slice(0, 12)}`),
    );
    expect(evaluateMergeCommitChecks(REQUIRED, onHead, MERGE, { treeEquivalentSha: HEAD }).ok).toBe(
      true,
    );
  });

  it('judges the latest attempt of a re-run check', () => {
    const rerun = [
      ...allGreen.filter((c) => c.name !== 'Contracts Dep Lint'),
      check('Contracts Dep Lint', { id: 10, conclusion: 'failure' }),
      check('Contracts Dep Lint', { id: 11 }),
    ];
    expect(evaluateMergeCommitChecks(REQUIRED, rerun, MERGE).ok).toBe(true);
    const regressed = [
      ...allGreen.filter((c) => c.name !== 'Contracts Dep Lint'),
      check('Contracts Dep Lint', { id: 10 }),
      check('Contracts Dep Lint', { id: 11, conclusion: 'failure' }),
    ];
    expect(evaluateMergeCommitChecks(REQUIRED, regressed, MERGE).ok).toBe(false);
  });

  it('ranks per event: a later push run never hides a failed pull_request run on the head (fix 5)', () => {
    const head = [
      ...onHead.filter((c) => c.name !== 'CI'),
      check('CI', { headSha: HEAD, event: 'pull_request', id: 5, conclusion: 'failure' }),
      check('CI', { headSha: HEAD, event: 'push', id: 9 }),
    ];
    const r = evaluateMergeCommitChecks(REQUIRED, head, MERGE, { treeEquivalentSha: HEAD });
    expect(r.ok).toBe(false);
  });

  it('ranks per event on the merge commit: a later run of another event never hides a failure (fix 5)', () => {
    const merge = [
      ...allGreen.filter((c) => c.name !== 'Contracts Dep Lint'),
      check('Contracts Dep Lint', { event: 'push', id: 5, conclusion: 'failure' }),
      check('Contracts Dep Lint', { event: 'workflow_dispatch', id: 9 }),
    ];
    const r = evaluateMergeCommitChecks(REQUIRED, merge, MERGE);
    expect(!r.ok && r.reasons.join('\n')).toMatch(/Contracts Dep Lint: failure/);
  });

  it('the head substitution uses pull_request runs only, never push runs (fix 5)', () => {
    const pushOnly = onHead.map((c) => ({ ...c, event: 'push' }));
    expect(
      evaluateMergeCommitChecks(REQUIRED, pushOnly, MERGE, { treeEquivalentSha: HEAD }).ok,
    ).toBe(false);
  });

  it('a pinned check never counts from a different app (fix 3)', () => {
    const pins = { CI: { app: 'github-actions', workflow: '.github/workflows/ci.yml' } };
    const forged = [
      ...allGreen.filter((c) => c.name !== 'CI'),
      check('CI', { appSlug: 'evil-bot', workflowPath: undefined }),
    ];
    const r = evaluateMergeCommitChecks(REQUIRED, forged, MERGE, { pins });
    expect(r.ok).toBe(false);
    expect(!r.ok && r.reasons.join('\n')).toMatch(/CI: posted by evil-bot, not the pinned app/);
    // The genuine run alongside the impostor still counts.
    expect(evaluateMergeCommitChecks(REQUIRED, [...allGreen, ...forged], MERGE, { pins }).ok).toBe(
      true,
    );
    // A numeric app-id pin (branch protection) refuses a slug-only impostor too.
    expect(
      evaluateMergeCommitChecks(REQUIRED, forged, MERGE, { pins: { CI: { app: 12345 } } }).ok,
    ).toBe(false);
  });

  it('refuses an empty required set rather than accepting vacuously', () => {
    expect(evaluateMergeCommitChecks([], allGreen, MERGE).ok).toBe(false);
  });
});

describe('resolveCiEvidenceAtom', () => {
  let root: string;
  const merged: PrAtomResolution = {
    ok: true,
    prNumber: 42,
    mergeCommitSha: MERGE,
    mergedAt: '2026-09-28T00:00:00Z',
    successCount: 3,
    totalChecks: 3,
    cacheHit: false,
    title: 'fix(T1): the change',
    body: '',
    headRefName: 'task/T1',
    headRefOid: HEAD,
    changedPaths: ['a.ts'],
    changedFileCount: 1,
  };

  function writeContext(evidence: Record<string, unknown>): void {
    mkdirSync(join(root, '.cleo'), { recursive: true });
    writeFileSync(join(root, '.cleo', 'project-context.json'), JSON.stringify({ evidence }));
  }
  const optedIn = {
    ciSatisfies: true,
    ciChecks: {
      tests: ['CI'],
      qa: ['CI', 'Lockfile Check', 'Contracts Dep Lint'],
      jobs: { tests: ['Unit Tests*'], qa: ['Type Check', 'Lint & Format'] },
    },
  };

  function resolve(extra: Partial<ResolveCiEvidenceOptions> = {}) {
    return resolveCiEvidenceAtom(
      42,
      { storeRoot: root, executionRoot: root },
      {
        context: context(),
        projectContext: PINNED,
        resolvePr: async () => merged,
        fetchChecks: async (sha) => ({
          ok: true,
          checks: sha === MERGE ? allGreen : sha === HEAD ? onHead : [],
        }),
        treeOf: () => null,
        firstParentOf: () => PARENT,
        isAncestor: () => false,
        onDefaultBranch: () => ({ ref: 'origin/main', landed: true }),
        ...extra,
      },
    );
  }

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'ci-atom-'));
    process.env[PR_REQUIRED_WORKFLOWS_ENV_VAR] = REQUIRED.join(',');
  });
  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
    delete process.env[PR_REQUIRED_WORKFLOWS_ENV_VAR];
  });

  it('is disabled by default and names the opt-in', async () => {
    expect(readCiSatisfies(root)).toBe(false);
    const r = await resolve();
    expect(!r.ok && r.reason).toMatch(/evidence\.ciSatisfies/);
  });

  it('only `true` enables it', () => {
    writeContext({ ciSatisfies: 'yes' });
    expect(readCiSatisfies(root)).toBe(false);
    writeContext({ ciSatisfies: true });
    expect(readCiSatisfies(root)).toBe(true);
  });

  it('accepts green merge-commit CI, recording task, gate checks, checks and merge commit', async () => {
    writeContext(optedIn);
    let queried = '';
    const r = await resolve({
      context: context('T1', ['testsPassed', 'qaPassed']),
      fetchChecks: async (sha) => {
        queried = sha;
        return { ok: true, checks: allGreen };
      },
    });
    expect(queried).toBe(MERGE);
    expect(r.ok, JSON.stringify(r)).toBe(true);
    const atom = r.ok ? r.atom : null;
    expect(atom).toMatchObject({
      kind: 'ci',
      prNumber: 42,
      mergeCommitSha: MERGE,
      taskId: 'T1',
      gateChecks: {
        testsPassed: [
          'CI',
          'Unit Tests (ubuntu-latest, shard 1)',
          'Unit Tests (ubuntu-latest, shard 2)',
        ],
        qaPassed: ['CI', 'Lockfile Check', 'Contracts Dep Lint', 'Type Check', 'Lint & Format'],
      },
    });
    expect(atom?.kind === 'ci' && atom.checks.find((c) => c.name === 'CI')).toMatchObject({
      sha: MERGE,
      app: 'github-actions',
      workflow: '.github/workflows/ci.yml',
    });
  });

  it('a scheduled run on the merge commit never decides its verdict (T13623)', async () => {
    writeContext(optedIn);
    const nightly = [
      check('CI', {
        source: 'workflow-run',
        workflowPath: '.github/workflows/ci.yml',
        event: 'schedule',
        id: 50,
        conclusion: 'failure',
      }),
      check('Unit Tests (ubuntu-latest, shard 1)', {
        workflowPath: '.github/workflows/ci.yml',
        event: 'schedule',
        id: 51,
        conclusion: 'failure',
      }),
    ];
    const r = await resolve({
      context: context('T1', ['testsPassed', 'qaPassed']),
      fetchChecks: async () => ({ ok: true, checks: [...allGreen, ...nightly] }),
    });
    expect(r.ok, JSON.stringify(r)).toBe(true);
  });

  it('refuses an unmerged PR through the pr: provenance result', async () => {
    writeContext(optedIn);
    const r = await resolve({
      resolvePr: async () => ({
        ok: false,
        reason: 'PR #42 is in state OPEN',
        codeName: 'E_EVIDENCE_INSUFFICIENT',
      }),
    });
    expect(!r.ok && r.reason).toMatch(/OPEN/);
  });

  it('refuses a PR that neither cites nor touches an unrelated task (fix 1)', async () => {
    writeContext(optedIn);
    const r = await resolve({ context: context('T999') });
    expect(r.ok).toBe(false);
    expect(!r.ok && r.codeName).toBe('E_EVIDENCE_CONTENT_MISMATCH');
    expect(!r.ok && r.reason).toMatch(/does not establish a relationship to task T999/);
  });

  it('ci:<component>@<integration> links the task through the component PR (T12671)', async () => {
    writeContext(optedIn);
    const viewed: number[] = [];
    const r = await resolve({
      componentPrNumber: 40,
      viewComponentPr: async (n) => {
        viewed.push(n);
        return {
          number: n,
          title: 'T1: work',
          body: '',
          headRefName: 'task/T1',
          baseRefName: 'some/other-branch',
          state: 'MERGED',
          mergeCommitSha: HEAD,
        };
      },
    });
    expect(viewed).toEqual([40]);
    expect(!r.ok && r.reason).toMatch(/Component PR #40 merged into some\/other-branch/);
  });

  it('a PR merged into an integration branch that later landed on the default branch: accepted', async () => {
    writeContext(optedIn);
    let asked = '';
    const r = await resolve({
      onDefaultBranch: (sha) => {
        asked = sha;
        return { ref: 'origin/main', landed: true };
      },
    });
    expect(asked).toBe(MERGE);
    expect(r.ok, JSON.stringify(r)).toBe(true);
  });

  it('a PR whose merge never reached the default branch: refused "not on origin/main"', async () => {
    writeContext(optedIn);
    const r = await resolve({ onDefaultBranch: () => ({ ref: 'origin/main', landed: false }) });
    expect(r.ok).toBe(false);
    expect(!r.ok && r.reason).toMatch(/not on origin\/main/);
  });

  it('refuses when the default branch cannot be determined', async () => {
    writeContext(optedIn);
    const r = await resolve({ onDefaultBranch: () => ({ ref: null, landed: false }) });
    expect(!r.ok && r.reason).toMatch(/Cannot determine origin's default branch/);
  });

  it('refuses without task context', async () => {
    writeContext(optedIn);
    const r = await resolve({ context: undefined });
    expect(!r.ok && r.reason).toMatch(/requires current task/);
  });

  it('refuses a gate whose ciChecks list is not configured (fix 4)', async () => {
    writeContext({ ciSatisfies: true, ciChecks: { tests: ['CI'] } });
    const r = await resolve({ context: context('T1', ['qaPassed']) });
    expect(!r.ok && r.reason).toMatch(/evidence\.ciChecks\.qa/);
    writeContext({ ciSatisfies: true });
    expect(!(await resolve()).ok).toBe(true);
  });

  it('refuses a ciChecks list that names a check outside the required set (fix 4)', async () => {
    writeContext({ ciSatisfies: true, ciChecks: { tests: ['Unit Tests'] } });
    const r = await resolve();
    expect(!r.ok && r.reason).toMatch(/not required \(tests:Unit Tests\)/);
  });

  it('refuses vacuous CI: an empty required-workflow set, from config or env, whatever ciSatisfies says (T13757)', async () => {
    delete process.env[PR_REQUIRED_WORKFLOWS_ENV_VAR];
    writeContext(optedIn);
    const fromConfig = await resolve({ projectContext: { release: { prRequiredWorkflows: [] } } });
    expect(!fromConfig.ok && fromConfig.codeName, JSON.stringify(fromConfig)).toBe(
      'E_EVIDENCE_CI_VACUOUS',
    );
    expect(!fromConfig.ok && fromConfig.reason).toMatch(
      /zero checks.*test-run:<report>.*qa-run:<receipt>.*tool:config-schema.*release\.prRequiredWorkflows/,
    );
    process.env[PR_REQUIRED_WORKFLOWS_ENV_VAR] = '[]';
    const fromEnv = await resolve();
    expect(!fromEnv.ok && fromEnv.codeName).toBe('E_EVIDENCE_CI_VACUOUS');
  });

  it('refuses when the only CI run was posted by an app other than the pinned one (fix 3)', async () => {
    delete process.env[PR_REQUIRED_WORKFLOWS_ENV_VAR];
    writeContext(optedIn);
    const forged = [
      ...allGreen.filter((c) => c.name !== 'CI'),
      check('CI', { appSlug: 'evil-bot', workflowPath: undefined }),
    ];
    const r = await resolve({ fetchChecks: async () => ({ ok: true, checks: forged }) });
    expect(!r.ok && r.reason).toMatch(/CI: posted by evil-bot/);
  });

  it('refuses when a check that attests a gate is unpinned, naming the fix (round 2 #3)', async () => {
    writeContext(optedIn);
    const r = await resolve({
      projectContext: {
        release: {
          prRequiredWorkflows: [
            { name: 'CI', app: 'github-actions', workflow: '.github/workflows/ci.yml' },
            'Lockfile Check',
            'Contracts Dep Lint',
          ],
        },
      },
      context: context('T1', ['qaPassed']),
    });
    expect(!r.ok && r.reason).toMatch(
      /unpinned check\(s\) Lockfile Check, Contracts Dep Lint: declare each in release\.prRequiredWorkflows/,
    );
  });

  describe('a PR that edits a pinned workflow: main push CI only (T13174)', () => {
    beforeEach(() => writeContext(optedIn));
    const editing: PrAtomResolution = {
      ...merged,
      changedPaths: ['a.ts', '.github/workflows/ci.yml'],
      changedFileCount: 2,
    };
    const DESC = '1'.repeat(40);
    const onDesc = allGreen.map((c) => ({ ...c, headSha: DESC, event: 'push' }));
    const cancelledMerge = allGreen.map((c) =>
      c.workflowPath === '.github/workflows/ci.yml' ? { ...c, conclusion: 'cancelled' } : c,
    );
    const redHead = onHead.map((c) => ({ ...c, conclusion: 'failure' }));

    it("is attested by the merge commit's push CI, never consulting the PR's own runs", async () => {
      const fetched: string[] = [];
      const r = await resolve({
        context: context('T1', ['testsPassed', 'qaPassed']),
        resolvePr: async () => editing,
        // A tree-equal head would normally be consulted; for an edited workflow it is not.
        treeOf: () => TREE,
        isAncestor: () => true,
        fetchChecks: async (sha) => {
          fetched.push(sha);
          return { ok: true, checks: sha === MERGE ? allGreen : redHead };
        },
      });
      expect(r.ok, JSON.stringify(r)).toBe(true);
      expect(r.ok && r.atom.kind === 'ci' && r.atom.mainOnly).toBe(true);
      expect(fetched).toEqual([MERGE]);
    });

    it('a merge-commit push run whose jobs were skipped never counts', async () => {
      const unitSkipped = allGreen.map((c) =>
        c.name.startsWith('Unit Tests') ? { ...c, conclusion: 'skipped' } : c,
      );
      const r = await resolve({
        resolvePr: async () => editing,
        fetchChecks: async (sha) => ({ ok: true, checks: sha === MERGE ? unitSkipped : onHead }),
      });
      expect(r.ok).toBe(false);
      expect(!r.ok && r.reason).toMatch(/job Unit Tests \(ubuntu-latest, shard 1\): skipped/);
    });

    it('no main push run yet: refused with a wait-for-main-CI message, no local run', async () => {
      const r = await resolve({
        resolvePr: async () => editing,
        fetchChecks: async () => ({ ok: true, checks: [] }),
        listDescendants: () => [],
      });
      expect(r.ok).toBe(false);
      expect(!r.ok && r.reason).toMatch(
        /only main's push CI attests it \(T13174\): wait for the push run on aaaaaaaaaaaa/,
      );
      expect(!r.ok && r.reason).not.toMatch(/tool:test/);
    });

    it('a cancelled merge-commit run stands in for by a later green main run, even with a red PR head', async () => {
      const r = await resolve({
        context: context('T1', ['testsPassed', 'qaPassed']),
        resolvePr: async () => editing,
        fetchChecks: async (sha) => ({
          ok: true,
          checks: sha === MERGE ? cancelledMerge : sha === DESC ? onDesc : redHead,
        }),
        listDescendants: () => [DESC],
        isAncestor: (a, d) => a === MERGE && d === DESC,
        touchingCommits: () => [],
      });
      expect(r.ok, JSON.stringify(r)).toBe(true);
      const atom = r.ok && r.atom.kind === 'ci' ? r.atom : null;
      expect(atom?.descendantSha).toBe(DESC);
      expect(atom?.descendantPrHeadSha).toBeUndefined();
      expect(atom?.mainOnly).toBe(true);
    });
  });

  describe('jobs covering the changed paths (T13175)', () => {
    const covering = {
      ...optedIn,
      ciChecks: {
        ...optedIn.ciChecks,
        covering: {
          tests: [{ paths: ['scripts/**'], jobs: ['Scripts Tests'] }],
          qa: [{ paths: ['scripts/**'], jobs: ['Lint & Format'] }],
        },
      },
    };
    beforeEach(() => writeContext(covering));
    // Detect Changes skipped the package jobs; Scripts Tests ran.
    const scriptsRun = [
      ...allGreen.map((c) =>
        c.name.startsWith('Unit Tests') || c.name === 'Type Check'
          ? { ...c, conclusion: 'skipped' }
          : c,
      ),
      check('Scripts Tests', { id: 9, workflowPath: '.github/workflows/ci.yml' }),
    ];
    const pr = (paths: string[]) => async () => ({
      ...merged,
      changedPaths: paths,
      changedFileCount: paths.length,
    });

    it('a scripts-only PR with the unit shards skipped by their filter: accepted via Scripts Tests', async () => {
      const r = await resolve({
        context: context('T1', ['testsPassed', 'qaPassed']),
        resolvePr: pr(['scripts/__tests__/x.test.mjs']),
        fetchChecks: async () => ({ ok: true, checks: scriptsRun }),
      });
      expect(r.ok, JSON.stringify(r)).toBe(true);
      expect(r.ok && r.atom.kind === 'ci' && r.atom.gateChecks?.testsPassed).toContain(
        'Scripts Tests',
      );
      expect(r.ok && r.atom.kind === 'ci' && r.atom.gateChecks?.qaPassed).toContain(
        'Lint & Format',
      );
    });

    it('a package PR whose unit shards were skipped: refused, no rule covers its path', async () => {
      const r = await resolve({
        resolvePr: pr(['packages/core/src/a.ts']),
        fetchChecks: async () => ({ ok: true, checks: scriptsRun }),
      });
      expect(r.ok).toBe(false);
      expect(!r.ok && r.reason).toMatch(/packages\/core\/src\/a\.ts is covered by no evidence/);
    });

    it('a mixed PR (scripts plus a package): refused', async () => {
      const r = await resolve({
        resolvePr: pr(['scripts/a.mjs', 'packages/core/src/a.ts']),
        fetchChecks: async () => ({ ok: true, checks: scriptsRun }),
      });
      expect(r.ok).toBe(false);
    });

    it('a CANCELLED unit shard is not a filter skip: refused even for a scripts-only PR', async () => {
      const cancelled = scriptsRun.map((c) =>
        c.name === 'Unit Tests (ubuntu-latest, shard 1)' ? { ...c, conclusion: 'cancelled' } : c,
      );
      const r = await resolve({
        resolvePr: pr(['scripts/a.mjs']),
        fetchChecks: async () => ({ ok: true, checks: cancelled }),
      });
      expect(r.ok).toBe(false);
      expect(!r.ok && r.reason).toMatch(/cancelled, not skipped by its filter/);
    });

    it('a required job missing entirely is not a filter skip: refused', async () => {
      const r = await resolve({
        resolvePr: pr(['scripts/a.mjs']),
        fetchChecks: async () => ({
          ok: true,
          checks: scriptsRun.filter((c) => !c.name.startsWith('Unit Tests')),
        }),
      });
      expect(r.ok).toBe(false);
      expect(!r.ok && r.reason).toMatch(/missing, not skipped/);
    });

    it('the covering job itself failed: refused', async () => {
      const r = await resolve({
        resolvePr: pr(['scripts/a.mjs']),
        fetchChecks: async () => ({
          ok: true,
          checks: scriptsRun.map((c) =>
            c.name === 'Scripts Tests' ? { ...c, conclusion: 'failure' } : c,
          ),
        }),
      });
      expect(r.ok).toBe(false);
      expect(!r.ok && r.reason).toMatch(/job Scripts Tests: failure/);
    });

    it('without a covering rule configured, the skip is refused as before', async () => {
      writeContext(optedIn);
      const r = await resolve({
        resolvePr: pr(['scripts/a.mjs']),
        fetchChecks: async () => ({ ok: true, checks: scriptsRun }),
      });
      expect(!r.ok && r.reason).toMatch(/job Unit Tests \(ubuntu-latest, shard 1\): skipped/);
    });

    it('path globs: **/ is whole directories, * stays in a segment, ? is one character', () => {
      expect(pathGlobToRegExp('scripts/**').test('scripts/lib/a.mjs')).toBe(true);
      expect(pathGlobToRegExp('**/x.md').test('x.md')).toBe(true);
      expect(pathGlobToRegExp('**/x.md').test('docs/a/x.md')).toBe(true);
      expect(pathGlobToRegExp('**/x.md').test('ax.md')).toBe(false);
      expect(pathGlobToRegExp('scripts/*.mjs').test('scripts/lib/a.mjs')).toBe(false);
      expect(pathGlobToRegExp('a?.ts').test('ab.ts')).toBe(true);
      expect(pathGlobToRegExp('a?.ts').test('a/.ts')).toBe(false);
      expect(pathGlobToRegExp('a.ts').test('aXts')).toBe(false);
    });

    it('a malformed covering rule voids the whole list', () => {
      writeContext({
        ...optedIn,
        ciChecks: {
          ...optedIn.ciChecks,
          covering: {
            tests: [{ paths: ['scripts/**'], jobs: ['Scripts Tests'] }, { paths: ['x/**'] }],
          },
        },
      });
      expect(readCiChecks(root).covering).toBeUndefined();
    });
  });

  describe('skipped jobs on a code task (round 2 #1)', () => {
    beforeEach(() => writeContext(optedIn));
    const unitSkipped = allGreen.map((c) =>
      c.name.startsWith('Unit Tests') ? { ...c, conclusion: 'skipped' } : c,
    );

    it('code task with Unit Tests skipped: refused, naming the job', async () => {
      const r = await resolve({ fetchChecks: async () => ({ ok: true, checks: unitSkipped }) });
      expect(r.ok).toBe(false);
      expect(!r.ok && r.reason).toMatch(/job Unit Tests \(ubuntu-latest, shard 1\): skipped/);
    });

    it('code task with a job missing entirely: refused', async () => {
      const r = await resolve({
        context: context('T1', ['qaPassed']),
        fetchChecks: async () => ({
          ok: true,
          checks: allGreen.filter((c) => c.name !== 'Type Check'),
        }),
      });
      expect(!r.ok && r.reason).toMatch(/job Type Check: not found/);
    });

    it('a docs LABEL does not excuse skipped jobs on a code diff (round 3 #1)', async () => {
      const labelled: EvidenceValidationContext = {
        ...context(),
        task: { ...context().task, labels: ['docs'] },
      };
      const r = await resolve({
        context: labelled,
        fetchChecks: async () => ({ ok: true, checks: unitSkipped }),
      });
      expect(r.ok).toBe(false);
      expect(!r.ok && r.reason).toMatch(/job Unit Tests \(ubuntu-latest, shard 1\): skipped/);
    });

    it('a docs-labelled task whose diff IS documentation only: accepted', async () => {
      const labelled: EvidenceValidationContext = {
        ...context(),
        task: { ...context().task, labels: ['docs'] },
      };
      const r = await resolve({
        context: labelled,
        resolvePr: async () => ({
          ...merged,
          changedPaths: ['docs/guide.md'],
          changedFileCount: 1,
        }),
        fetchChecks: async () => ({ ok: true, checks: unitSkipped }),
      });
      expect(r.ok, JSON.stringify(r)).toBe(true);
    });

    it('a .md under packages/** is code: a runtime template change with Unit Tests skipped is refused (round 3 #2)', async () => {
      const r = await resolve({
        resolvePr: async () => ({
          ...merged,
          changedPaths: ['packages/core/templates/CLEO-INJECTION.md'],
          changedFileCount: 1,
        }),
        fetchChecks: async () => ({ ok: true, checks: unitSkipped }),
      });
      expect(r.ok).toBe(false);
      expect(!r.ok && r.reason).toMatch(/job Unit Tests.*skipped/);
    });

    it('a mixed diff (docs plus code) with Unit Tests skipped is refused (round 3 #3)', async () => {
      const r = await resolve({
        resolvePr: async () => ({
          ...merged,
          changedPaths: ['README.md', 'a.ts'],
          changedFileCount: 2,
        }),
        fetchChecks: async () => ({ ok: true, checks: unitSkipped }),
      });
      expect(r.ok).toBe(false);
    });

    it('code task whose PR diff is documentation only: the skip is honest, accepted', async () => {
      const r = await resolve({
        resolvePr: async () => ({
          ...merged,
          changedPaths: ['AGENTS.md', 'docs/x.md'],
          changedFileCount: 2,
        }),
        fetchChecks: async () => ({ ok: true, checks: unitSkipped }),
      });
      expect(r.ok, JSON.stringify(r)).toBe(true);
    });

    it('code task with Unit Tests success: accepted, the jobs recorded', async () => {
      const r = await resolve();
      expect(r.ok, JSON.stringify(r)).toBe(true);
      expect(r.ok && r.atom.gateChecks?.testsPassed).toEqual([
        'CI',
        'Unit Tests (ubuntu-latest, shard 1)',
        'Unit Tests (ubuntu-latest, shard 2)',
      ]);
    });

    it('code task without job globs configured: refused, naming the key', async () => {
      writeContext({ ciSatisfies: true, ciChecks: { tests: ['CI'], qa: ['CI'] } });
      const r = await resolve();
      expect(!r.ok && r.reason).toMatch(/evidence\.ciChecks\.jobs\.tests/);
    });

    it('a job posted by a workflow outside the pinned ones never counts', async () => {
      const elsewhere = allGreen.map((c) =>
        c.name.startsWith('Unit Tests') ? { ...c, workflowPath: '.github/workflows/other.yml' } : c,
      );
      const r = await resolve({ fetchChecks: async () => ({ ok: true, checks: elsewhere }) });
      expect(!r.ok && r.reason).toMatch(/job Unit Tests\*: not found/);
    });
  });

  describe('PR-head substitution', () => {
    beforeEach(() => writeContext(optedIn));
    const cancelledOnMerge = allGreen.map((c) =>
      c.name === 'CI' ? { ...c, conclusion: 'cancelled' } : c,
    );
    const trees =
      (map: Record<string, string>) =>
      (sha: string): string | null =>
        map[sha] ?? null;

    it('tree-equal head with the merge parent as its ancestor: accepted, head sha recorded', async () => {
      const r = await resolve({
        fetchChecks: async (sha) => ({ ok: true, checks: sha === HEAD ? onHead : [] }),
        treeOf: trees({ [MERGE]: TREE, [HEAD]: TREE }),
        isAncestor: (a, d) => a === PARENT && d === HEAD,
      });
      expect(r.ok, JSON.stringify(r)).toBe(true);
      expect(r.ok && r.atom.testedTree).toBe(TREE);
      expect(r.ok && r.atom.checks.every((c) => c.sha === HEAD && c.event === 'pull_request')).toBe(
        true,
      );
    });

    it('cancelled main push run + tree-equal PR run: accepted', async () => {
      const r = await resolve({
        fetchChecks: async (sha) => ({
          ok: true,
          checks: sha === MERGE ? cancelledOnMerge : sha === HEAD ? onHead : [],
        }),
        treeOf: trees({ [MERGE]: TREE, [HEAD]: TREE }),
        isAncestor: () => true,
      });
      expect(r.ok, JSON.stringify(r)).toBe(true);
      const bySha = Object.fromEntries((r.ok ? r.atom.checks : []).map((c) => [c.name, c.sha]));
      expect(bySha).toEqual({ CI: HEAD, 'Lockfile Check': MERGE, 'Contracts Dep Lint': MERGE });
    });

    it('tree-different head: refused, falling back to merge-commit checks', async () => {
      const r = await resolve({
        fetchChecks: async (sha) => ({
          ok: true,
          checks: sha === MERGE ? cancelledOnMerge : sha === HEAD ? onHead : [],
        }),
        treeOf: trees({ [MERGE]: TREE, [HEAD]: 'd'.repeat(40) }),
        isAncestor: () => true,
      });
      expect(!r.ok && r.reason).toMatch(/CI: cancelled on merge commit/);
    });

    it('COUNTEREXAMPLE: equal trees but the merge parent is not an ancestor of the head: refused (fix 2)', async () => {
      // Base gained X, CI tested head+X, base reverted X: the merge tree equals
      // the head tree, yet the head WITHOUT X was never tested.
      const r = await resolve({
        fetchChecks: async (sha) => ({
          ok: true,
          checks: sha === MERGE ? cancelledOnMerge : sha === HEAD ? onHead : [],
        }),
        treeOf: trees({ [MERGE]: TREE, [HEAD]: TREE }),
        isAncestor: () => false,
      });
      expect(!r.ok && r.reason).toMatch(/CI: cancelled on merge commit/);
    });

    it('unknown trees never count as equal', async () => {
      const r = await resolve({
        fetchChecks: async (sha) => ({ ok: true, checks: sha === HEAD ? onHead : [] }),
        treeOf: () => null,
        isAncestor: () => true,
      });
      expect(r.ok).toBe(false);
    });
  });

  describe('green main CI on a descendant commit (T12742)', () => {
    beforeEach(() => writeContext(optedIn));
    const CI_WORKFLOW = '.github/workflows/ci.yml';
    /** The whole ci.yml run was cancelled by the concurrency group; Lockfile Check is green. */
    const cancelledMerge = allGreen.map((c) =>
      c.workflowPath === CI_WORKFLOW ? { ...c, conclusion: 'cancelled' } : c,
    );
    const onSha = (sha: string, patch: Partial<CommitCheck> = {}) =>
      allGreen.map((c) => ({ ...c, headSha: sha, event: 'push', ...patch }));
    const DESC1 = '1'.repeat(40);
    const DESC2 = '2'.repeat(40);
    const OTHER_MERGE = '4'.repeat(40);
    const DIRECT = '3'.repeat(40);

    function descend(
      byDescendant: Record<string, CommitCheck[]>,
      extra: Partial<ResolveCiEvidenceOptions> = {},
    ) {
      const fetched: string[] = [];
      const run = resolve({
        context: context('T1', ['testsPassed', 'qaPassed']),
        fetchChecks: async (sha) => {
          fetched.push(sha);
          return {
            ok: true,
            checks:
              sha === MERGE ? cancelledMerge : sha === HEAD ? onHead : (byDescendant[sha] ?? []),
          };
        },
        listDescendants: () => Object.keys(byDescendant),
        isAncestor: (a, d) => a === MERGE && d in byDescendant,
        touchingCommits: () => [],
        ...extra,
      });
      return { run, fetched };
    }

    it('cancelled merge-commit run + green PR head + green push run on an untouched descendant: accepted, provenance recorded', async () => {
      const seen: string[][] = [];
      const { run } = descend(
        { [DESC1]: onSha(DESC1) },
        {
          touchingCommits: (_from, _to, paths) => {
            seen.push([...paths]);
            return [];
          },
        },
      );
      const r = await run;
      expect(r.ok, JSON.stringify(r)).toBe(true);
      const atom = r.ok ? r.atom : null;
      expect(atom?.kind === 'ci' && atom.descendantSha).toBe(DESC1);
      expect(atom?.kind === 'ci' && atom.descendantRange).toBe(`${MERGE}..${DESC1}`);
      expect(atom?.kind === 'ci' && atom.descendantPrHeadSha).toBe(HEAD);
      // The PR's files AND the pinned CI definitions were both checked.
      expect(seen).toContainEqual(['a.ts']);
      expect(seen.flat()).toEqual(
        expect.arrayContaining([
          '.github/workflows/ci.yml',
          '.github/workflows/lockfile-check.yml',
          '.github/actions',
        ]),
      );
      const bySha = Object.fromEntries(
        (atom?.kind === 'ci' ? atom.checks : []).map((c) => [c.name, c.sha]),
      );
      expect(bySha).toEqual({ CI: DESC1, 'Lockfile Check': MERGE, 'Contracts Dep Lint': DESC1 });
      expect(atom?.kind === 'ci' && atom.gateChecks?.testsPassed).toContain(
        'Unit Tests (ubuntu-latest, shard 1)',
      );
    });

    it('skips a descendant whose own run was also cancelled, accepting the next green one', async () => {
      const { run } = descend({
        [DESC1]: onSha(DESC1).map((c) =>
          c.workflowPath === CI_WORKFLOW ? { ...c, conclusion: 'cancelled' } : c,
        ),
        [DESC2]: onSha(DESC2),
      });
      const r = await run;
      expect(r.ok, JSON.stringify(r)).toBe(true);
      expect(r.ok && r.atom.kind === 'ci' && r.atom.descendantSha).toBe(DESC2);
    });

    it('T13846: a descendant whose push run skipped the test jobs is passed over for the next one where they ran', async () => {
      // #2330's shape: the first main commit after the merge was scripts-only,
      // so ci.yml's aggregate went green while its Unit Tests jobs never ran.
      const noUnitTests = onSha(DESC1).filter((c) => !c.name.startsWith('Unit Tests'));
      const { run } = descend({ [DESC1]: noUnitTests, [DESC2]: onSha(DESC2) });
      const r = await run;
      expect(r.ok, JSON.stringify(r)).toBe(true);
      expect(r.ok && r.atom.kind === 'ci' && r.atom.descendantSha).toBe(DESC2);
      expect(r.ok && r.atom.kind === 'ci' && r.atom.gateChecks?.testsPassed).toContain(
        'Unit Tests (ubuntu-latest, shard 1)',
      );
    });

    it('T13846: skipped or cancelled test jobs on a descendant also move on', async () => {
      const skipped = onSha(DESC1).map((c) =>
        c.name.startsWith('Unit Tests') ? { ...c, conclusion: 'skipped' } : c,
      );
      const { run } = descend({ [DESC1]: skipped, [DESC2]: onSha(DESC2) });
      const r = await run;
      expect(r.ok && r.atom.kind === 'ci' && r.atom.descendantSha, JSON.stringify(r)).toBe(DESC2);
    });

    it('T13846: a test job that FAILED on the descendant refuses; no later run is shopped for', async () => {
      const failedJob = onSha(DESC1).map((c) =>
        c.name === 'Unit Tests (ubuntu-latest, shard 1)' ? { ...c, conclusion: 'failure' } : c,
      );
      const { run, fetched } = descend({ [DESC1]: failedJob, [DESC2]: onSha(DESC2) });
      const r = await run;
      expect(r.ok).toBe(false);
      expect(!r.ok && r.reason).toMatch(/Unit Tests \(ubuntu-latest, shard 1\): failure/);
      expect(fetched).not.toContain(DESC2);
    });

    it('T13846: with no descendant where the test jobs ran, it still refuses, naming why', async () => {
      const noUnitTests = (sha: string) =>
        onSha(sha).filter((c) => !c.name.startsWith('Unit Tests'));
      const { run } = descend({ [DESC1]: noUnitTests(DESC1), [DESC2]: noUnitTests(DESC2) });
      const r = await run;
      expect(r.ok).toBe(false);
      expect(!r.ok && r.reason).toMatch(
        /No later main run stands in: no later origin\/main commit/,
      );
    });

    it('a FAILED merge-commit run is never stood in for, even with a green descendant', async () => {
      const failedMerge = allGreen.map((c) =>
        c.name === 'CI' ? { ...c, conclusion: 'failure' } : c,
      );
      const { run, fetched } = descend(
        { [DESC1]: onSha(DESC1) },
        {
          fetchChecks: async (sha) => ({
            ok: true,
            checks: sha === MERGE ? failedMerge : onSha(DESC1),
          }),
        },
      );
      const r = await run;
      expect(r.ok).toBe(false);
      expect(!r.ok && r.codeName).toBe('E_EVIDENCE_TESTS_FAILED');
      expect(!r.ok && r.reason).toMatch(/CI: failure on merge commit.*real failure/s);
      expect(fetched).not.toContain(DESC1);
    });

    describe('a merge into a red main: inherited failures (T13453)', () => {
      const BASE = '5'.repeat(40);
      const RED = new Set(['CI', 'Unit Tests (ubuntu-latest, shard 1)']);
      const red = (sha: string, ids: number) =>
        allGreen.map((c) =>
          RED.has(c.name)
            ? { ...c, headSha: sha, conclusion: 'failure', id: c.id + ids }
            : { ...c, headSha: sha },
        );
      const parents = (sha: string) => (sha === MERGE ? BASE : null);

      it('every merge-commit failure also failed on its base: the green descendant stands in, recorded with both run ids', async () => {
        const { run } = descend(
          { [DESC1]: onSha(DESC1) },
          {
            firstParentOf: parents,
            fetchChecks: async (sha) => ({
              ok: true,
              checks:
                sha === MERGE
                  ? red(MERGE, 100)
                  : sha === BASE
                    ? red(BASE, 200)
                    : sha === HEAD
                      ? onHead
                      : onSha(DESC1),
            }),
          },
        );
        const r = await run;
        expect(r.ok, JSON.stringify(r)).toBe(true);
        const atom = r.ok && r.atom.kind === 'ci' ? r.atom : null;
        expect(atom?.descendantSha).toBe(DESC1);
        expect(atom?.inheritedFailures).toEqual(
          expect.arrayContaining([
            { name: 'CI', mergeRunId: 101, baseSha: BASE, baseRunId: 201 },
            {
              name: 'Unit Tests (ubuntu-latest, shard 1)',
              mergeRunId: 101,
              baseSha: BASE,
              baseRunId: 201,
            },
          ]),
        );
        expect(atom?.checks.find((c) => c.name === 'CI')?.sha).toBe(DESC1);
      });

      it('a failure the base did NOT have was introduced by the PR: refused, the descendant never consulted', async () => {
        const baseOnlyCiRed = allGreen.map((c) =>
          c.name === 'CI'
            ? { ...c, headSha: BASE, conclusion: 'failure' }
            : { ...c, headSha: BASE },
        );
        const { run, fetched } = descend(
          { [DESC1]: onSha(DESC1) },
          {
            firstParentOf: parents,
            fetchChecks: async (sha) => {
              fetched.push(sha);
              return {
                ok: true,
                checks:
                  sha === MERGE ? red(MERGE, 100) : sha === BASE ? baseOnlyCiRed : onSha(DESC1),
              };
            },
          },
        );
        const r = await run;
        expect(r.ok).toBe(false);
        expect(!r.ok && r.reason).toMatch(
          /Unit Tests \(ubuntu-latest, shard 1\): failure on merge commit .* but success on its base 555555555555 — the PR introduced this failure/,
        );
        expect(fetched).not.toContain(DESC1);
      });

      it('looks past a cancelled base run to the nearest decided ancestor', async () => {
        const OLDER = '6'.repeat(40);
        const cancelledBase = allGreen.map((c) => ({
          ...c,
          headSha: BASE,
          conclusion: 'cancelled',
        }));
        const { run } = descend(
          { [DESC1]: onSha(DESC1) },
          {
            firstParentOf: (sha) => (sha === MERGE ? BASE : sha === BASE ? OLDER : null),
            fetchChecks: async (sha) => ({
              ok: true,
              checks:
                sha === MERGE
                  ? red(MERGE, 100)
                  : sha === BASE
                    ? cancelledBase
                    : sha === OLDER
                      ? red(OLDER, 300)
                      : sha === HEAD
                        ? onHead
                        : onSha(DESC1),
            }),
          },
        );
        const r = await run;
        expect(r.ok, JSON.stringify(r)).toBe(true);
        expect(r.ok && r.atom.kind === 'ci' && r.atom.inheritedFailures?.[0]?.baseSha).toBe(OLDER);
      });
    });

    it('a job that failed before the run was cancelled is a real failure: refused', async () => {
      const partlyFailed = cancelledMerge.map((c) =>
        c.name === 'Unit Tests (ubuntu-latest, shard 2)' ? { ...c, conclusion: 'failure' } : c,
      );
      const { run } = descend(
        { [DESC1]: onSha(DESC1) },
        {
          fetchChecks: async (sha) => ({
            ok: true,
            checks: sha === MERGE ? partlyFailed : onSha(DESC1),
          }),
        },
      );
      const r = await run;
      expect(!r.ok && r.reason).toMatch(/Unit Tests \(ubuntu-latest, shard 2\): failure on merge/);
    });

    it('a timed-out merge-commit run is a failure, not a cancellation: refused', async () => {
      const timedOut = allGreen.map((c) =>
        c.workflowPath === CI_WORKFLOW ? { ...c, conclusion: 'timed_out' } : c,
      );
      const { run } = descend(
        { [DESC1]: onSha(DESC1) },
        {
          fetchChecks: async (sha) => ({
            ok: true,
            checks: sha === MERGE ? timedOut : onSha(DESC1),
          }),
        },
      );
      expect((await run).ok).toBe(false);
    });

    it('no later commit on main: refused, cancelled-only is not green', async () => {
      const { run } = descend({});
      const r = await run;
      expect(!r.ok && r.reason).toMatch(/CI: cancelled on merge commit/);
      expect(!r.ok && r.reason).toMatch(
        /No later main run stands in: no later origin\/main commit/,
      );
    });

    it('only cancelled runs on every descendant: refused', async () => {
      const cancelled = (sha: string) =>
        onSha(sha).map((c) =>
          c.workflowPath === CI_WORKFLOW ? { ...c, conclusion: 'cancelled' } : c,
        );
      const { run } = descend({ [DESC1]: cancelled(DESC1), [DESC2]: cancelled(DESC2) });
      expect((await run).ok).toBe(false);
    });

    it('the first decisive descendant FAILED: refused, never shopping past it to a later green run', async () => {
      const { run } = descend({
        [DESC1]: onSha(DESC1).map((c) => (c.name === 'CI' ? { ...c, conclusion: 'failure' } : c)),
        [DESC2]: onSha(DESC2),
      });
      const r = await run;
      expect(!r.ok && r.reason).toMatch(/CI: failure on later origin\/main commit 111111111111/);
    });

    it('a commit that is not a descendant of the merge never counts', async () => {
      const { run } = descend({ [DESC1]: onSha(DESC1) }, { isAncestor: () => false });
      expect((await run).ok).toBe(false);
    });

    it('a NON-merge commit on main changed the PR files before the descendant: refused', async () => {
      const { run } = descend(
        { [DESC1]: onSha(DESC1) },
        { touchingCommits: () => [{ sha: DIRECT, parents: 1 }] },
      );
      const r = await run;
      expect(!r.ok && r.reason).toMatch(
        /the PR's files changed on origin\/main by commit 333333333333/,
      );
    });

    it('a later MERGE that touched the PR files (a fix landing after it) is refused too', async () => {
      const { run } = descend(
        { [DESC1]: onSha(DESC1) },
        {
          touchingCommits: (_from, _to, paths) =>
            paths.includes('a.ts') ? [{ sha: OTHER_MERGE, parents: 2 }] : [],
        },
      );
      const r = await run;
      expect(r.ok).toBe(false);
      expect(!r.ok && r.reason).toMatch(
        /the PR's files changed on origin\/main by merge 444444444444/,
      );
    });

    it('a range commit that edited a pinned workflow file is refused (CI may have been weakened)', async () => {
      const { run } = descend(
        { [DESC1]: onSha(DESC1) },
        {
          touchingCommits: (_from, _to, paths) =>
            paths.includes('.github/workflows/ci.yml') ? [{ sha: OTHER_MERGE, parents: 2 }] : [],
        },
      );
      const r = await run;
      expect(r.ok).toBe(false);
      expect(!r.ok && r.reason).toMatch(/a CI definition .*changed on origin\/main by merge 4444/);
    });

    it("the PR head's own pull_request run was RED: a green descendant never rescues it", async () => {
      const redHead = onHead.map((c) =>
        c.workflowPath === CI_WORKFLOW && (c.name === 'CI' || c.source === 'workflow-run')
          ? { ...c, conclusion: 'failure' }
          : c,
      );
      const { run, fetched } = descend(
        { [DESC1]: onSha(DESC1) },
        {
          fetchChecks: async (sha) => ({
            ok: true,
            checks: sha === MERGE ? cancelledMerge : sha === HEAD ? redHead : onSha(DESC1),
          }),
        },
      );
      const r = await run;
      expect(r.ok).toBe(false);
      expect(!r.ok && r.reason).toMatch(/CI: failure on PR head bbbbbbbbbbbb/);
      expect(fetched).not.toContain(DESC1);
    });

    it('a PR head with no pull_request run at all is refused', async () => {
      const { run } = descend(
        { [DESC1]: onSha(DESC1) },
        {
          fetchChecks: async (sha) => ({
            ok: true,
            checks: sha === MERGE ? cancelledMerge : sha === HEAD ? [] : onSha(DESC1),
          }),
        },
      );
      const r = await run;
      expect(!r.ok && r.reason).toMatch(/no pull_request run on PR head/);
    });

    it('a PENDING run on the first candidate refuses with "wait", never moving on to a later green one', async () => {
      const { run, fetched } = descend({
        [DESC1]: onSha(DESC1).map((c) =>
          c.name === 'CI' ? { ...c, status: 'in_progress', conclusion: null } : c,
        ),
        [DESC2]: onSha(DESC2),
      });
      const r = await run;
      expect(r.ok).toBe(false);
      expect(!r.ok && r.reason).toMatch(/pending \(in_progress\).*wait for 111111111111/);
      expect(fetched).not.toContain(DESC2);
    });

    it('unreadable history between merge and descendant: refused', async () => {
      const { run } = descend({ [DESC1]: onSha(DESC1) }, { touchingCommits: () => null });
      expect((await run).ok).toBe(false);
    });

    it('a pull_request run on the descendant never stands in; only push runs on main do', async () => {
      const { run } = descend({ [DESC1]: onSha(DESC1, { event: 'pull_request' }) });
      expect((await run).ok).toBe(false);
    });

    it('a missing merge-commit run is not a cancellation: refused', async () => {
      const { run } = descend(
        { [DESC1]: onSha(DESC1) },
        {
          fetchChecks: async (sha) => ({
            ok: true,
            checks: sha === MERGE ? allGreen.filter((c) => c.name !== 'CI') : onSha(DESC1),
          }),
        },
      );
      const r = await run;
      expect(!r.ok && r.reason).toMatch(/only a cancelled or skipped run is stood in for/);
    });

    describe('red only on the flaky-quarantine budget, every test passing (T13809)', () => {
      const SHARD = 'Unit Tests (ubuntu-latest, shard 1)';
      /** A real over-budget shard log: timestamps, ANSI colour, all tests passed. */
      const BUDGET_LOG = [
        '2026-10-10T07:49:11.0000000Z \u001b[2m Test Files \u001b[22m \u001b[1m\u001b[32m260 passed\u001b[39m\u001b[22m\u001b[90m (260)\u001b[39m',
        '2026-10-10T07:49:11.0000000Z \u001b[2m      Tests \u001b[22m \u001b[1m\u001b[32m3335 passed\u001b[39m\u001b[22m\u001b[2m | \u001b[22m\u001b[33m3 skipped\u001b[39m (3339)',
        '2026-10-10T07:49:11.0000000Z \u001b[2m   Start at \u001b[22m 07:45:10',
        '2026-10-10T07:49:11.0000000Z \u001b[2m   Duration \u001b[22m 243.13s (transform 24.92s)',
        '2026-10-10T07:49:12.0000000Z ### Flaky quarantine over budget',
        '2026-10-10T07:49:12.0000000Z 11 tests are quarantined (most 10).',
        '2026-10-10T07:49:14.0000000Z ##[error]Process completed with exit code 1.',
      ].join('\n');
      const FAILED_LOG = BUDGET_LOG.replace('3335 passed', '1 failed | 3334 passed');
      /** One failing test that the over-budget quarantine lists: it would never have blocked. */
      const quarantinedFailure = (listed: boolean) =>
        [
          '2026-10-10T07:34:03.9Z  ❯  @cleocode/core  src/store/__tests__/agent-resolver.test.ts (22 tests | 1 failed) 4165ms',
          '2026-10-10T07:39:45.1Z \u001b[31m FAIL \u001b[39m  @cleocode/core  src/store/__tests__/agent-resolver.test.ts > W2-4 resolveAgent > T9037 — resolves via require',
          '2026-10-10T07:39:45.2Z  Test Files  1 failed | 258 passed | 1 skipped (260)',
          '2026-10-10T07:39:45.3Z       Tests  1 failed | 4091 passed | 13 todo (4106)',
          '2026-10-10T07:39:45.3Z    Start at  07:31:23',
          '2026-10-10T07:39:45.3Z    Duration  501.17s (transform 43.95s)',
          '2026-10-10T07:39:45.8Z ### Flaky quarantine over budget',
          '2026-10-10T07:39:45.8Z ',
          '2026-10-10T07:39:45.8Z 11 tests are quarantined (most 10). Fix flaky tests.',
          '2026-10-10T07:39:45.8Z ',
          `2026-10-10T07:39:45.9Z - \`packages/core/src/store/__tests__/${listed ? 'agent-resolver' : 'project-info'}.test.ts\` > W2-4 resolveAgent T9037 — resolves via require`,
        ].join('\n');
      /** CI (job + workflow run) and shard 1 failed on `sha`, everything else green. */
      const budgetRed = (sha: string, event = 'push') =>
        allGreen.map((c) =>
          c.name === 'CI' || c.name === SHARD
            ? { ...c, headSha: sha, event, conclusion: 'failure', id: c.id + 100 }
            : { ...c, headSha: sha, event },
        );
      const logs =
        (log: string) =>
        async (jobId: number): Promise<string | null> =>
          jobId === 101 ? log : null;
      const checksFor =
        (bySha: Record<string, CommitCheck[]>) =>
        async (sha: string): Promise<{ ok: true; checks: CommitCheck[] }> => ({
          ok: true,
          checks: bySha[sha] ?? (sha === HEAD ? onHead : []),
        });

      it('isQuarantineBudgetOnlyLog: the budget heading with every test passed, nothing else', () => {
        expect(isQuarantineBudgetOnlyLog(BUDGET_LOG)).toBe(true);
        expect(isQuarantineBudgetOnlyLog(FAILED_LOG)).toBe(false);
        expect(
          isQuarantineBudgetOnlyLog(BUDGET_LOG.replace('### Flaky quarantine over budget', '')),
        ).toBe(false);
        // vitest's own error section comes before the script's heading.
        expect(
          isQuarantineBudgetOnlyLog(
            BUDGET_LOG.replace('### Flaky', ' Unhandled Errors \n### Flaky'),
          ),
        ).toBe(false);
        expect(isQuarantineBudgetOnlyLog('### Flaky quarantine over budget')).toBe(false);
        // A failing test the quarantine lists never blocks; one it does not list does.
        expect(isQuarantineBudgetOnlyLog(quarantinedFailure(true))).toBe(true);
        expect(isQuarantineBudgetOnlyLog(quarantinedFailure(false))).toBe(false);
        // A file that failed to load (no test named) is never the budget alone.
        expect(
          isQuarantineBudgetOnlyLog(
            quarantinedFailure(true).replace('1 failed | 258 passed', '2 failed | 257 passed'),
          ),
        ).toBe(false);
        // A summary a test echoed never stands in for the run's own (review probe, T13814):
        // the per-file line shows 4 failures and the shard was killed before its summary.
        const echoed = [
          ' ✓ packages/x/a.test.ts (3 tests) 20ms',
          'stdout | packages/y/parse.test.ts > parses a vitest summary',
          ' Test Files  1 passed (1)',
          '      Tests  2 passed (2)',
          ' ❯ packages/z/big.test.ts (12 tests | 4 failed)',
          'Killed',
          '### Flaky quarantine over budget',
          '',
          '31 tests are quarantined (most 30)',
        ].join('\n');
        expect(isQuarantineBudgetOnlyLog(echoed)).toBe(false);
        // Each guard alone refuses it: no timing lines, a per-file failure, a worker crash.
        expect(isQuarantineBudgetOnlyLog(echoed.replace('\nKilled', ''))).toBe(false);
        expect(
          isQuarantineBudgetOnlyLog(
            BUDGET_LOG.replace(
              '### Flaky',
              ' ❯ packages/z/big.test.ts (12 tests | 4 failed)\n### Flaky',
            ),
          ),
        ).toBe(false);
        expect(
          isQuarantineBudgetOnlyLog(
            BUDGET_LOG.replace(
              '### Flaky',
              'Error: [vitest-pool]: Worker exited unexpectedly\n### Flaky',
            ),
          ),
        ).toBe(false);
        // A test's child process printing `Killed` is ordinary output, not a crash.
        expect(
          isQuarantineBudgetOnlyLog(BUDGET_LOG.replace('### Flaky', 'Killed\n### Flaky')),
        ).toBe(true);
        // A FULL block a child vitest echoed, followed by more results and a kill
        // (review, T13814): the run's own summary is its last vitest output.
        const echoedFull = [
          ' ✓ packages/x/a.test.ts (3 tests) 20ms',
          'stdout | packages/y/child.test.ts > runs a child vitest',
          ' Test Files  1 passed (1)',
          '      Tests  2 passed (2)',
          '   Start at  10:00:00',
          '   Duration  1.2s',
          ' ✓ packages/x/b.test.ts (5 tests) 30ms',
          'Killed',
          '### Flaky quarantine over budget',
          '',
          '31 tests are quarantined (most 30)',
        ].join('\n');
        expect(isQuarantineBudgetOnlyLog(echoedFull)).toBe(false);
        // A full block a child vitest echoed through inherited stdio (no `stdout |`
        // prefix), then only unprefixed child output and a kill mid-test (T13809 residual).
        const echoedUnprefixed = [
          ' ✓ packages/x/a.test.ts (3 tests) 20ms',
          'child: running 1 file',
          ' Test Files  1 passed (1)',
          '      Tests  2 passed (2)',
          '   Start at  10:00:00',
          '   Duration  1.2s',
          'child: exited 0',
          'Killed',
          '### Flaky quarantine over budget',
          '',
          '31 tests are quarantined (most 30)',
        ].join('\n');
        expect(isQuarantineBudgetOnlyLog(echoedUnprefixed)).toBe(false);
        // The preceding line alone refuses it: after a blank line the block reads as the run's own.
        expect(
          isQuarantineBudgetOnlyLog(echoedUnprefixed.replace('child: running 1 file', '')),
        ).toBe(true);
        // Real logs print the script's report line between the summary and the heading.
        expect(
          isQuarantineBudgetOnlyLog(
            BUDGET_LOG.replace(
              '### Flaky',
              'JSON report written to /tmp/flaky-quarantine-x/first.json\n### Flaky',
            ),
          ),
        ).toBe(true);
        // The heading must be the script's own verdict, with its count line.
        expect(
          isQuarantineBudgetOnlyLog(BUDGET_LOG.replace('11 tests are quarantined (most 10).', '')),
        ).toBe(false);
      });

      it('the merge commit failed only on the budget: the green descendant stands in, the jobs recorded', async () => {
        const { run } = descend(
          { [DESC1]: onSha(DESC1) },
          {
            fetchChecks: checksFor({ [MERGE]: budgetRed(MERGE), [DESC1]: onSha(DESC1) }),
            fetchJobLog: logs(BUDGET_LOG),
          },
        );
        const r = await run;
        expect(r.ok, JSON.stringify(r)).toBe(true);
        const atom = r.ok && r.atom.kind === 'ci' ? r.atom : null;
        expect(atom?.descendantSha).toBe(DESC1);
        expect(atom?.nonTestFailures).toEqual([{ name: SHARD, mergeRunId: 101 }]);
        expect(atom?.inheritedFailures).toBeUndefined();
        expect(atom?.checks.find((c) => c.name === 'CI')?.sha).toBe(DESC1);
      });

      it('a shard with a failing test is a real failure: refused, the descendant never consulted', async () => {
        const fetched: string[] = [];
        const fetchChecks = checksFor({ [MERGE]: budgetRed(MERGE), [DESC1]: onSha(DESC1) });
        const refused = await resolve({
          context: context('T1', ['testsPassed', 'qaPassed']),
          fetchChecks: async (sha) => {
            fetched.push(sha);
            return fetchChecks(sha);
          },
          listDescendants: () => [DESC1],
          isAncestor: (a, d) => a === MERGE && d === DESC1,
          touchingCommits: () => [],
          fetchJobLog: logs(FAILED_LOG),
        });
        expect(refused.ok).toBe(false);
        expect(!refused.ok && refused.reason).toMatch(/real failure/);
        expect(fetched).not.toContain(DESC1);
      });

      it('looks past a later run red only on the budget to the next green one', async () => {
        const fetchChecks = checksFor({
          [MERGE]: budgetRed(MERGE),
          [DESC1]: budgetRed(DESC1).map((c) => (c.id > 100 ? { ...c, id: c.id + 1000 } : c)),
          [DESC2]: onSha(DESC2),
        });
        const r = await resolve({
          context: context('T1', ['testsPassed', 'qaPassed']),
          fetchChecks,
          listDescendants: () => [DESC1, DESC2],
          isAncestor: (a, d) => a === MERGE && (d === DESC1 || d === DESC2),
          touchingCommits: () => [],
          fetchJobLog: async (jobId) => (jobId === 101 || jobId === 1101 ? BUDGET_LOG : null),
        });
        expect(r.ok, JSON.stringify(r)).toBe(true);
        expect(r.ok && r.atom.kind === 'ci' && r.atom.descendantSha).toBe(DESC2);
      });

      it('looks past a later run a concurrency group cancelled, its interrupted jobs failing with no test failed', async () => {
        const cancelledRed = budgetRed(DESC1).map((c) => {
          const bumped = c.id > 100 ? { ...c, id: c.id + 1000 } : c;
          return c.source === 'workflow-run' && c.name === 'CI'
            ? { ...bumped, conclusion: 'cancelled' }
            : bumped;
        });
        const r = await resolve({
          context: context('T1', ['testsPassed', 'qaPassed']),
          fetchChecks: checksFor({
            [MERGE]: budgetRed(MERGE),
            [DESC1]: cancelledRed,
            [DESC2]: onSha(DESC2),
          }),
          listDescendants: () => [DESC1, DESC2],
          isAncestor: (a, d) => a === MERGE && (d === DESC1 || d === DESC2),
          touchingCommits: () => [],
          fetchJobLog: async (jobId) => (jobId === 101 ? BUDGET_LOG : jobId === 1101 ? '' : null),
        });
        expect(r.ok, JSON.stringify(r)).toBe(true);
        expect(r.ok && r.atom.kind === 'ci' && r.atom.descendantSha).toBe(DESC2);
      });

      /** A real shard log (4aa2c96a5422): the build artifact was missing, no test ran. */
      const SETUP_FAILED_LOG = [
        '2026-10-12T13:04:44.7729273Z ##[group]Run actions/cache@v4',
        '2026-10-12T13:04:55.5346561Z ##[group]Run actions/download-artifact@v4',
        '2026-10-12T13:04:55.5346999Z with:',
        '2026-10-12T13:04:55.7985540Z ##[error]Unable to download artifact(s): Artifact not found for name: build-output-ubuntu-latest',
        '2026-10-12T13:04:55.8241304Z ##[group]Run actions/upload-artifact@v4',
      ].join('\n');

      it('isSetupStepFailureLog: an action step failing before any test ran, nothing else', () => {
        expect(isSetupStepFailureLog(SETUP_FAILED_LOG)).toBe(true);
        // A `run:` step failing (a gate script, a test command) is a real failure.
        expect(
          isSetupStepFailureLog(
            SETUP_FAILED_LOG.replace(
              'Run actions/download-artifact@v4',
              'Run node scripts/lint-paths-ssot.mjs',
            ),
          ),
        ).toBe(false);
        // Any vitest output means tests ran.
        expect(isSetupStepFailureLog(`${SETUP_FAILED_LOG}\n RUN  v4.1.4 /w`)).toBe(false);
        expect(isSetupStepFailureLog(BUDGET_LOG)).toBe(false);
        expect(isSetupStepFailureLog(SETUP_FAILED_LOG.replace('##[error]', ''))).toBe(false);
      });

      it('looks past a later run whose shards failed before any test ran (T12730, 4aa2c96a)', async () => {
        const run = (descLog: string) =>
          resolve({
            context: context('T1', ['testsPassed', 'qaPassed']),
            fetchChecks: checksFor({
              [MERGE]: budgetRed(MERGE),
              [DESC1]: budgetRed(DESC1).map((c) => (c.id > 100 ? { ...c, id: c.id + 1000 } : c)),
              [DESC2]: onSha(DESC2),
            }),
            listDescendants: () => [DESC1, DESC2],
            isAncestor: (a, d) => a === MERGE && (d === DESC1 || d === DESC2),
            touchingCommits: () => [],
            fetchJobLog: async (jobId) =>
              jobId === 101 ? BUDGET_LOG : jobId === 1101 ? descLog : null,
          });
        const r = await run(SETUP_FAILED_LOG);
        expect(r.ok, JSON.stringify(r)).toBe(true);
        expect(r.ok && r.atom.kind === 'ci' && r.atom.descendantSha).toBe(DESC2);
        // The same failure in a `run:` step still refuses.
        const refused = await run(
          SETUP_FAILED_LOG.replace('Run actions/download-artifact@v4', 'Run pnpm run test'),
        );
        expect(refused.ok).toBe(false);
        expect(!refused.ok && refused.reason).toMatch(/failure on later origin\/main commit/);
      });

      it('a code task: a merge-commit job red only on the budget ran its tests, so the job gate holds', async () => {
        // CI is attested by the tree-equal PR head; the PR's affected-only run skipped shard 1.
        const headSkipped = onHead.map((c) =>
          c.name === SHARD ? { ...c, conclusion: 'skipped' } : c,
        );
        const run = (fetchJobLog: ResolveCiEvidenceOptions['fetchJobLog']) =>
          resolve({
            fetchChecks: checksFor({ [MERGE]: budgetRed(MERGE), [HEAD]: headSkipped }),
            treeOf: (sha) => (sha === MERGE || sha === HEAD ? TREE : null),
            isAncestor: (a, d) => a === PARENT && d === HEAD,
            ...(fetchJobLog ? { fetchJobLog } : {}),
          });
        const held = await run(logs(BUDGET_LOG));
        expect(held.ok, JSON.stringify(held)).toBe(true);
        const refused = await run(logs(FAILED_LOG));
        expect(refused.ok, JSON.stringify(refused)).toBe(false);
        expect(!refused.ok && refused.reason).toMatch(
          /Unit Tests \(ubuntu-latest, shard 1\): failure/,
        );
      });

      it('a later run with a real failure still refuses: no green run is shopped for past it', async () => {
        const r = await resolve({
          context: context('T1', ['testsPassed', 'qaPassed']),
          fetchChecks: checksFor({
            [MERGE]: budgetRed(MERGE),
            [DESC1]: budgetRed(DESC1).map((c) => (c.id > 100 ? { ...c, id: c.id + 1000 } : c)),
            [DESC2]: onSha(DESC2),
          }),
          listDescendants: () => [DESC1, DESC2],
          isAncestor: (a, d) => a === MERGE && (d === DESC1 || d === DESC2),
          touchingCommits: () => [],
          fetchJobLog: async (jobId) =>
            jobId === 101 ? BUDGET_LOG : jobId === 1101 ? FAILED_LOG : null,
        });
        expect(r.ok).toBe(false);
        expect(!r.ok && r.reason).toMatch(/failure on later origin\/main commit 111111111111/);
      });
    });
  });

  describe("a runner-cancelled job is a cancelled verdict, not the PR's failure (T14049)", () => {
    beforeEach(() => writeContext(optedIn));
    const CI_WORKFLOW = '.github/workflows/ci.yml';
    const BUILD = 'Build (ubuntu-latest)';
    const BASE = '5'.repeat(40);
    const DESC1 = '1'.repeat(40);
    const BUILD_RUN = 121239058058;
    /** The tail of job 121239058058 (run 40216344634, attempt 1). */
    const CANCELLED_LOG = [
      '2026-10-25T17:31:16.9522922Z ##[group]Run pnpm run build',
      '2026-10-25T17:31:34.8024053Z [build] Wave 5: core (esbuild + tsc declarations)',
      '2026-10-25T17:32:58.2678389Z   -> packages/core/dist/index.js',
      '2026-10-25T17:32:58.2723377Z   Generating type declarations...',
      '2026-10-25T17:33:29.9244353Z ##[error]The runner has received a shutdown signal. This can happen when the runner service is stopped, or a manually started runner is canceled.',
      '2026-10-25T17:33:30.1291390Z  ELIFECYCLE  Command failed.',
      '2026-10-25T17:33:30.3115532Z ##[error]The operation was canceled.',
      '2026-10-25T17:33:30.3916926Z Cleaning up orphan processes',
    ].join('\n');
    /** Merge commit 40e763c4ae03: Build cancelled by the runner, its dependants skipped, CI red. */
    const cancelledBuild = (sha: string): CommitCheck[] => [
      ...allGreen.map((c) =>
        c.name === 'CI'
          ? { ...c, headSha: sha, conclusion: 'failure', id: c.id + 100 }
          : c.workflowPath === CI_WORKFLOW && c.name !== 'Contracts Dep Lint'
            ? { ...c, headSha: sha, conclusion: 'skipped' }
            : { ...c, headSha: sha },
      ),
      check(BUILD, {
        headSha: sha,
        id: BUILD_RUN,
        conclusion: 'failure',
        workflowPath: CI_WORKFLOW,
      }),
    ];
    const onSha = (sha: string) => allGreen.map((c) => ({ ...c, headSha: sha, event: 'push' }));
    const run = (log: string, descendants: string[] = [DESC1]) =>
      resolve({
        context: context('T1', ['testsPassed', 'qaPassed']),
        fetchChecks: async (sha) => ({
          ok: true,
          checks:
            sha === MERGE
              ? cancelledBuild(MERGE)
              : sha === HEAD
                ? onHead
                : sha === BASE || sha === DESC1
                  ? onSha(sha)
                  : [],
        }),
        firstParentOf: (sha) => (sha === MERGE ? BASE : null),
        listDescendants: () => descendants,
        isAncestor: (a, d) => a === MERGE && descendants.includes(d),
        touchingCommits: () => [],
        fetchJobLog: async (jobId) => (jobId === BUILD_RUN ? log : null),
      });

    it('isRunnerCancelOnlyLog: only GitHub cancellation errors and no failed test', () => {
      expect(isRunnerCancelOnlyLog(CANCELLED_LOG)).toBe(true);
      expect(isRunnerCancelOnlyLog(CANCELLED_LOG.replace(/.*shutdown signal.*\n/, ''))).toBe(true);
      // A real error before the cancellation, or a failed test, is a real failure.
      expect(
        isRunnerCancelOnlyLog(`##[error]Process completed with exit code 1.\n${CANCELLED_LOG}`),
      ).toBe(false);
      expect(isRunnerCancelOnlyLog(`${CANCELLED_LOG}\n Tests  1 failed | 9 passed (10)`)).toBe(
        false,
      );
      // A shutdown notice without the cancellation is not one.
      expect(isRunnerCancelOnlyLog(CANCELLED_LOG.replace(/.*operation was canceled.*/, ''))).toBe(
        false,
      );
    });

    it('run 40216344634: base green, the green descendant stands in, nothing blamed on the PR', async () => {
      const r = await run(CANCELLED_LOG);
      expect(r.ok, JSON.stringify(r)).toBe(true);
      const atom = r.ok && r.atom.kind === 'ci' ? r.atom : null;
      expect(atom?.descendantSha).toBe(DESC1);
      expect(atom?.checks.find((c) => c.name === 'CI')?.sha).toBe(DESC1);
      expect(atom?.inheritedFailures).toBeUndefined();
      expect(atom?.untestedFailures).toEqual([
        { name: BUILD, mergeRunId: BUILD_RUN, cause: 'runner-cancel' },
      ]);
    });

    /** The tail of job 122254128778 (main f89392f76, rerun attempt 2): a fork aborted, no test failed. */
    const CRASHED_LOG = [
      "2026-10-27T14:48:35.1480399Z terminate called after throwing an instance of 'Napi::Error'",
      '2026-10-27T14:48:51.4747847Z [vitest-pool]: Timeout terminating forks worker for test files /home/runner/work/cleo/cleo/packages/core/src/memory/__tests__/brain-writer-thread.test.ts.',
      '2026-10-27T14:51:26.3819329Z      ✓ resolves global domain paths to the canonical global store  2412ms',
      '2026-10-27T14:51:26.3929394Z ⎯⎯⎯⎯⎯⎯ Unhandled Errors ⎯⎯⎯⎯⎯⎯',
      '2026-10-27T14:51:26.3931471Z Vitest caught 1 unhandled error during the test run.',
      '2026-10-27T14:51:26.3962900Z ⎯⎯⎯⎯⎯⎯ Unhandled Error ⎯⎯⎯⎯⎯⎯⎯',
      '2026-10-27T14:51:26.3964304Z Error: [vitest-pool]: Worker forks emitted error.',
      '2026-10-27T14:51:26.3976700Z Caused by: Error: Worker exited unexpectedly',
      '2026-10-27T14:51:26.4001389Z  Test Files  280 passed (281)',
      '2026-10-27T14:51:26.4034756Z       Tests  4071 passed | 2 skipped (4075)',
      '2026-10-27T14:51:26.4036050Z      Errors  1 error',
      '2026-10-27T14:51:27.7295644Z ##[error]Process completed with exit code 1.',
    ].join('\n');

    it('isWorkerCrashOnlyLog (T14074): a pool worker crash with no failed test, nothing else', () => {
      expect(isWorkerCrashOnlyLog(CRASHED_LOG)).toBe(true);
      // Any failed test or file is a real failure.
      expect(
        isWorkerCrashOnlyLog(
          CRASHED_LOG.replace('Tests  4071 passed', 'Tests  1 failed | 4070 passed'),
        ),
      ).toBe(false);
      expect(isWorkerCrashOnlyLog(`${CRASHED_LOG}\n FAIL   src/x.test.ts > breaks`)).toBe(false);
      // An unhandled error a test raised is not the pool's own crash.
      expect(
        isWorkerCrashOnlyLog(
          CRASHED_LOG.replace(
            '⎯⎯⎯⎯⎯⎯ Unhandled Error ⎯⎯⎯⎯⎯⎯⎯',
            '⎯⎯⎯⎯⎯⎯ Unhandled Error ⎯⎯⎯⎯⎯⎯⎯\nTypeError: boom\n⎯⎯⎯⎯⎯⎯ Unhandled Error ⎯⎯⎯⎯⎯⎯⎯',
          ),
        ),
      ).toBe(false);
      // Another step's error is not the crash alone.
      expect(isWorkerCrashOnlyLog(`##[error]TS2322\n${CRASHED_LOG}`)).toBe(false);
    });

    it('T14074: a worker-crash-only merge commit is stood in for by the green descendant, the cause recorded', async () => {
      const r = await run(CRASHED_LOG);
      expect(r.ok, JSON.stringify(r)).toBe(true);
      const atom = r.ok && r.atom.kind === 'ci' ? r.atom : null;
      expect(atom?.descendantSha).toBe(DESC1);
      expect(atom?.untestedFailures).toEqual([
        { name: BUILD, mergeRunId: BUILD_RUN, cause: 'worker-crash' },
      ]);
    });

    it('T14074: a crash beside a failed test is never stood in for', async () => {
      const r = await run(`${CRASHED_LOG}\n FAIL   src/x.test.ts > breaks`);
      expect(r.ok).toBe(false);
      expect(!r.ok && r.reason).toMatch(/the PR introduced this failure/);
    });

    it('with no later green run the refusal waits on a stand-in and never says the PR introduced it', async () => {
      const r = await run(CANCELLED_LOG, []);
      expect(r.ok).toBe(false);
      expect(!r.ok && r.reason).toMatch(
        /No later main run stands in: no later origin\/main commit/,
      );
      expect(!r.ok && r.reason).not.toMatch(/introduced/);
    });

    it('a Build log with a real error is still a failure the base did not have', async () => {
      const r = await run(
        CANCELLED_LOG.replace('Generating type declarations...', '##[error]TS2322'),
      );
      expect(r.ok).toBe(false);
      expect(!r.ok && r.reason).toMatch(/the PR introduced this failure/);
    });
  });

  describe('a check run with incomplete identity is pending, never a foreign app (T13017)', () => {
    beforeEach(() => writeContext(optedIn));
    /** The T12959 response: CI's check run came back without its workflow file. */
    const partial = allGreen.map((c) => (c.name === 'CI' ? { ...c, workflowPath: undefined } : c));

    it('judges the partial run pending, naming no app mismatch', () => {
      const pins = { CI: { app: 'github-actions', workflow: '.github/workflows/ci.yml' } };
      const r = evaluateMergeCommitChecks(REQUIRED, partial, MERGE, { pins });
      expect(r.ok).toBe(false);
      const reasons = !r.ok ? r.reasons.join('\n') : '';
      expect(reasons).toMatch(
        /CI: pending \(GitHub has not reported its run's app or workflow yet\)/,
      );
      expect(reasons).not.toMatch(/posted by/);
      expect(hasIncompleteIdentity(partial, REQUIRED, pins)).toBe(true);
      expect(hasIncompleteIdentity(allGreen, REQUIRED, pins)).toBe(false);
    });

    it('a genuine mismatch still refuses, showing both values', () => {
      const pins = { CI: { app: 'github-actions', workflow: '.github/workflows/ci.yml' } };
      const other = allGreen.map((c) =>
        c.name === 'CI' ? { ...c, workflowPath: '.github/workflows/other.yml' } : c,
      );
      const r = evaluateMergeCommitChecks(REQUIRED, other, MERGE, { pins });
      expect(!r.ok && r.reasons.join('\n')).toMatch(
        /CI: posted by github-actions \(\.github\/workflows\/other\.yml\), not the pinned app github-actions \/ workflow \.github\/workflows\/ci\.yml/,
      );
    });

    it('re-fetches a partial response and judges the complete one', async () => {
      const fetched: string[] = [];
      const r = await resolve({
        fetchChecks: async (sha) => {
          fetched.push(sha);
          const first = fetched.filter((s) => s === MERGE).length === 1;
          return {
            ok: true,
            checks: sha === MERGE ? (first ? partial : allGreen) : sha === HEAD ? onHead : [],
          };
        },
      });
      expect(r.ok, JSON.stringify(r)).toBe(true);
      expect(fetched.filter((s) => s === MERGE)).toHaveLength(2);
    });

    it('a response still partial after the retry is refused as pending', async () => {
      const r = await resolve({
        fetchChecks: async (sha) => ({
          ok: true,
          checks: sha === MERGE ? partial : sha === HEAD ? onHead : [],
        }),
        listDescendants: () => [],
      });
      expect(r.ok).toBe(false);
      expect(!r.ok && r.reason).toMatch(
        /^Required CI on PR #42's merge commit aaaaaaaaaaaa is not green: CI: pending/,
      );
      expect(!r.ok && r.reason).not.toMatch(/posted by/);
    });
  });

  describe('the decisive reason leads the CI refusal (T14042)', () => {
    beforeEach(() => writeContext(optedIn));

    it('a red merge commit: the failing check and the next step are in the first 200 characters', async () => {
      const red = allGreen.map((c) =>
        c.name === 'Lockfile Check' ? { ...c, conclusion: 'failure' } : c,
      );
      const r = await resolve({
        fetchChecks: async (sha) => ({ ok: true, checks: sha === MERGE ? red : [] }),
        listDescendants: () => [],
      });
      const head200 = !r.ok ? r.reason.slice(0, 200) : '';
      expect(head200).toMatch(/is not green: Lockfile Check: failure on merge commit aaaaaaaaaaaa/);
    });

    it('a PR editing a pinned workflow: the wait instruction is in the first 200 characters', async () => {
      const r = await resolve({
        resolvePr: async () => ({
          ...merged,
          changedPaths: ['a.ts', '.github/workflows/ci.yml'],
          changedFileCount: 2,
        }),
        fetchChecks: async () => ({ ok: true, checks: [] }),
        listDescendants: () => [],
      });
      const head200 = !r.ok ? r.reason.slice(0, 200) : '';
      expect(head200).toMatch(/edits the pinned workflow \.github\/workflows\/ci\.yml/);
      expect(head200).toMatch(/wait for the push run on aaaaaaaaaaaa/);
    });
  });

  describe('a workspace-wide change: green CI on the current main HEAD stands in (T14032)', () => {
    // EscapePlan's shape: a lockfile change, merge CI red from a re-run of a
    // secrets job, later commits editing the lockfile again, and a green full
    // CI on today's main HEAD.
    const LATER = '7'.repeat(40);
    const PREV = '8'.repeat(40);
    const CUR = '9'.repeat(40);
    const lockfilePr: PrAtomResolution = { ...merged, changedPaths: ['pnpm-lock.yaml'] };
    const redMerge = allGreen.map((c) => (c.name === 'CI' ? { ...c, conclusion: 'failure' } : c));
    const onSha = (sha: string, patch: Partial<CommitCheck> = {}) =>
      allGreen.map((c) => ({ ...c, headSha: sha, event: 'push', ...patch }));
    const onMain = [LATER, PREV, CUR];

    beforeEach(() => {
      writeContext(optedIn);
      writeFileSync(join(root, 'pnpm-workspace.yaml'), 'packages:\n  - packages/*\n');
      mkdirSync(join(root, 'packages', 'a'), { recursive: true });
      writeFileSync(join(root, 'packages', 'a', 'package.json'), '{"name":"@x/a"}');
    });

    function onCurrentHead(
      byCommit: Record<string, CommitCheck[]>,
      extra: Partial<ResolveCiEvidenceOptions> = {},
    ) {
      const fetched: string[] = [];
      const run = resolve({
        context: context('T1', ['testsPassed', 'qaPassed']),
        resolvePr: async () => lockfilePr,
        fetchChecks: async (sha) => {
          fetched.push(sha);
          return {
            ok: true,
            checks: sha === MERGE ? redMerge : sha === HEAD ? onHead : (byCommit[sha] ?? []),
          };
        },
        // The T12742 walk sees the later lockfile edit and refuses.
        listDescendants: () => onMain,
        touchingCommits: (_from, _to, paths) =>
          paths.includes('pnpm-lock.yaml') ? [{ sha: LATER, parents: 2 }] : [],
        isAncestor: (a, d) => a === MERGE && onMain.includes(d),
        firstParentOf: (sha) => (sha === CUR ? PREV : sha === PREV ? LATER : PARENT),
        defaultBranchHead: () => CUR,
        changedBetween: () => [],
        ...extra,
      });
      return { run, fetched };
    }

    it('red merge CI + later lockfile edits + green push CI on HEAD: accepted', async () => {
      const r = await onCurrentHead({ [CUR]: onSha(CUR) }).run;
      expect(r.ok, JSON.stringify(r)).toBe(true);
      const atom = r.ok && r.atom.kind === 'ci' ? r.atom : null;
      expect(atom?.descendantSha).toBe(CUR);
      expect(atom?.descendantRange).toBe(`${MERGE}..${CUR}`);
      expect(atom?.descendantPrHeadSha).toBeUndefined();
      expect(atom?.workspaceWide).toMatch(/pnpm-lock\.yaml/);
      expect(Object.fromEntries((atom?.checks ?? []).map((c) => [c.name, c.sha]))).toEqual({
        CI: CUR,
        'Lockfile Check': MERGE,
        'Contracts Dep Lint': MERGE,
      });
      expect(atom?.gateChecks?.testsPassed).toContain('Unit Tests (ubuntu-latest, shard 1)');
    });

    it('HEAD has no run yet, and the green parent differs from it only in docs: accepted', async () => {
      const r = await onCurrentHead(
        { [PREV]: onSha(PREV) },
        { changedBetween: (from, to) => (from === PREV && to === CUR ? ['README.md'] : null) },
      ).run;
      expect(r.ok && r.atom.kind === 'ci' && r.atom.descendantSha, JSON.stringify(r)).toBe(PREV);
    });

    it('the green run is not on HEAD and a test input moved since: refused, naming the route', async () => {
      const r = await onCurrentHead(
        { [PREV]: onSha(PREV) },
        { changedBetween: () => ['packages/a/src/x.ts'] },
      ).run;
      expect(r.ok).toBe(false);
      expect(!r.ok && r.codeName).toBe('E_EVIDENCE_TESTS_FAILED');
      expect(!r.ok && r.reason).toMatch(
        /No current-HEAD run stands in: the change is workspace-wide .*pnpm-lock\.yaml.*current origin\/main HEAD would stand in \(T14032\).*changes packages\/a\/src\/x\.ts.*wait for HEAD/,
      );
    });

    it('HEAD does not descend from the merge commit: refused', async () => {
      const r = await onCurrentHead(
        { [CUR]: onSha(CUR) },
        { isAncestor: (a, d) => a === MERGE && d !== CUR && onMain.includes(d) },
      ).run;
      expect(!r.ok && r.reason).toMatch(/HEAD 999999999999 does not descend from merge commit/);
    });

    it('a required check red on HEAD: refused, no earlier green run shopped for', async () => {
      const { run, fetched } = onCurrentHead({
        [CUR]: onSha(CUR).map((c) => (c.name === 'CI' ? { ...c, conclusion: 'failure' } : c)),
        [PREV]: onSha(PREV),
      });
      const r = await run;
      expect(!r.ok && r.reason).toMatch(/CI: failure on later origin\/main commit 999999999999/);
      expect(fetched).not.toContain(PREV);
    });

    it('a pending run on HEAD: refused with wait', async () => {
      const r = await onCurrentHead({
        [CUR]: onSha(CUR).map((c) =>
          c.name === 'CI' ? { ...c, status: 'in_progress', conclusion: null } : c,
        ),
      }).run;
      expect(!r.ok && r.reason).toMatch(/pending.*wait for 999999999999/);
    });

    it('a scoped change never takes the route (T12742 stays its only stand-in)', async () => {
      let asked = false;
      const r = await onCurrentHead(
        { [CUR]: onSha(CUR) },
        {
          resolvePr: async () => ({ ...lockfilePr, changedPaths: ['packages/a/src/x.ts'] }),
          touchingCommits: () => [{ sha: LATER, parents: 2 }],
          defaultBranchHead: () => {
            asked = true;
            return CUR;
          },
        },
      ).run;
      expect(r.ok).toBe(false);
      expect(!r.ok && r.reason).not.toMatch(/current-HEAD/);
      expect(asked).toBe(false);
    });

    it('complete-time re-check: a workspace-wide atom re-checks the HEAD push run alone', async () => {
      const r = await onCurrentHead({ [CUR]: onSha(CUR) }).run;
      const atom = r.ok && r.atom.kind === 'ci' ? r.atom : null;
      expect(atom).not.toBeNull();
      const asked: string[] = [];
      const green = await recheckCiDescendantAtom(atom!, root, async (sha) => {
        asked.push(sha);
        return { ok: true as const, checks: onSha(CUR) };
      });
      expect(green).toEqual({ ok: true });
      expect(asked).toEqual([CUR]);
      const rerun = [...onSha(CUR), { ...onSha(CUR)[0]!, id: 99, conclusion: 'failure' }];
      const red = await recheckCiDescendantAtom(atom!, root, async () => ({
        ok: true as const,
        checks: rerun,
      }));
      expect(!red.ok && red.reason).toMatch(/CI: now failure \(push\)/);
    });
  });

  describe('recheckCiDescendantAtom — an inherited failure must still be red on its base (T13453)', () => {
    const DESC = '1'.repeat(40);
    const BASE = '5'.repeat(40);
    const atom: Extract<EvidenceAtom, { kind: 'ci' }> = {
      kind: 'ci',
      prNumber: 42,
      mergeCommitSha: MERGE,
      checks: [],
      descendantSha: DESC,
      descendantRange: `${MERGE}..${DESC}`,
      descendantPrHeadSha: HEAD,
      inheritedFailures: [{ name: 'CI', mergeRunId: 101, baseSha: BASE, baseRunId: 201 }],
      requiredSource: 'project-context',
    };
    const base = (conclusion: string) =>
      allGreen.map((c) =>
        c.name === 'CI' ? { ...c, headSha: BASE, id: 205, conclusion } : { ...c, headSha: BASE },
      );
    it('holds while the base run is still red', async () => {
      const r = await recheckCiDescendantAtom(atom, root, async (sha) => ({
        ok: true,
        checks: sha === BASE ? base('failure') : [],
      }));
      expect(r.ok).toBe(true);
    });
    it('a base re-run that went green breaks the claim', async () => {
      const r = await recheckCiDescendantAtom(atom, root, async (sha) => ({
        ok: true,
        checks: sha === BASE ? base('success') : [],
      }));
      expect(!r.ok && r.reason).toMatch(/now success on base 555555555555/);
    });
  });

  describe('recheckCiDescendantAtom — complete-time re-check of a descendant stand-in (T12742)', () => {
    const DESC = '1'.repeat(40);
    const atom: Extract<EvidenceAtom, { kind: 'ci' }> = {
      kind: 'ci',
      prNumber: 42,
      mergeCommitSha: MERGE,
      checks: [
        {
          name: 'CI',
          conclusion: 'success',
          sha: DESC,
          app: 'github-actions',
          workflow: '.github/workflows/ci.yml',
          event: 'push',
        },
        { name: 'Lockfile Check', conclusion: 'success', sha: MERGE },
      ],
      descendantSha: DESC,
      descendantRange: `${MERGE}..${DESC}`,
      descendantPrHeadSha: HEAD,
      requiredSource: 'project-context',
    };
    const onDesc = allGreen.map((c) => ({ ...c, headSha: DESC, event: 'push' }));
    const fetchFrom =
      (desc: CommitCheck[], head: CommitCheck[] = onHead) =>
      async (sha: string) => ({ ok: true as const, checks: sha === DESC ? desc : head });

    it('still green: ok', async () => {
      expect(await recheckCiDescendantAtom(atom, '/nowhere', fetchFrom(onDesc))).toEqual({
        ok: true,
      });
    });

    it('a re-run attempt on the descendant went red: fails', async () => {
      const rerun = [...onDesc, { ...onDesc[0]!, id: 99, conclusion: 'failure' }];
      const r = await recheckCiDescendantAtom(atom, '/nowhere', fetchFrom(rerun));
      expect(!r.ok && r.reason).toMatch(/CI: now failure \(push\)/);
    });

    it('a re-run attempt on the PR head went red: fails', async () => {
      const rerun = [...onHead, { ...onHead[0]!, id: 99, conclusion: 'failure' }];
      const r = await recheckCiDescendantAtom(atom, '/nowhere', fetchFrom(onDesc, rerun));
      expect(!r.ok && r.reason).toMatch(/CI: now failure \(pull_request\)/);
    });

    it('checks cannot be fetched: fails closed', async () => {
      const r = await recheckCiDescendantAtom(atom, '/nowhere', async () => ({
        ok: false,
        reason: 'offline',
      }));
      expect(!r.ok && r.reason).toMatch(/cannot re-check ci:42.*offline/);
    });

    it('a main-only atom re-checks the descendant push run alone (T13174)', async () => {
      const mainOnlyAtom = { ...atom, descendantPrHeadSha: undefined, mainOnly: true };
      const asked: string[] = [];
      const r = await recheckCiDescendantAtom(mainOnlyAtom, '/nowhere', async (sha) => {
        asked.push(sha);
        return { ok: true as const, checks: onDesc };
      });
      expect(r).toEqual({ ok: true });
      expect(asked).toEqual([DESC]);
      const noHead = { ...atom, descendantPrHeadSha: undefined };
      expect((await recheckCiDescendantAtom(noHead, '/nowhere', fetchFrom(onDesc))).ok).toBe(false);
    });

    it('an atom without a descendant is untouched', async () => {
      const plain = { ...atom, descendantSha: undefined };
      expect(
        await recheckCiDescendantAtom(plain, '/nowhere', async () => {
          throw new Error('must not fetch');
        }),
      ).toEqual({ ok: true });
    });
  });

  it('refuses failing merge-commit CI with E_EVIDENCE_TESTS_FAILED', async () => {
    writeContext(optedIn);
    const r = await resolve({
      fetchChecks: async () => ({
        ok: true,
        checks: allGreen.map((c) => (c.name === 'CI' ? { ...c, conclusion: 'failure' } : c)),
      }),
    });
    expect(!r.ok && r.codeName).toBe('E_EVIDENCE_TESTS_FAILED');
  });
});

describe('gate rules accept a validated ci: atom for testsPassed and qaPassed only', () => {
  const ci = (taskId: string): EvidenceAtom => ({
    kind: 'ci',
    prNumber: 42,
    mergeCommitSha: MERGE,
    checks: [{ name: 'CI', conclusion: 'success', sha: MERGE }],
    requiredSource: 'env',
    taskId,
  });

  it('parses ci:<pr>', () => {
    expect(parseEvidence('ci:42').atoms).toEqual([{ kind: 'ci', prNumber: 42 }]);
    expect(() => parseEvidence('ci:abc')).toThrow();
  });

  it('satisfies the testsPassed and qaPassed minimums, not implemented', () => {
    expect(validateEvidenceForGate('testsPassed', [{ kind: 'ci' }]).ok).toBe(true);
    expect(validateEvidenceForGate('qaPassed', [{ kind: 'ci' }]).ok).toBe(true);
    expect(validateEvidenceForGate('implemented', [{ kind: 'ci' }]).ok).toBe(false);
  });

  it('counts as a verification result for its own task only (fix 1)', () => {
    expect(checkTaskEvidenceContext(context('T1'), 'testsPassed', [ci('T1')])).toBeNull();
    expect(checkTaskEvidenceContext(context('T1'), 'qaPassed', [ci('T1')])).toBeNull();
    expect(checkTaskEvidenceContext(context('T2'), 'testsPassed', [ci('T1')])).toMatch(
      /lacks verified task linkage/,
    );
    expect(checkTaskEvidenceContext(context('T1'), 'testsPassed', [])).not.toBeNull();
  });
});

describe('git defaults for the descendant rule, on a real repository (T12742)', () => {
  let repo: string;
  const git = (...args: string[]): string =>
    execFileSync('git', args, { cwd: repo, encoding: 'utf-8' }).trim();
  const write = (file: string, body: string): void => writeFileSync(join(repo, file), body);

  beforeEach(() => {
    repo = mkdtempSync(join(tmpdir(), 'ci-descendant-git-'));
    git('init', '-q', '-b', 'main');
    git('config', 'user.email', 'test@example.com');
    git('config', 'user.name', 'test');
    git('config', 'commit.gpgsign', 'false');
  });
  afterEach(() => rmSync(repo, { recursive: true, force: true }));

  /** init → M1 (merges pr1: a.ts) → direct b.ts → M2 (merges pr2: a.ts) → direct b.ts. */
  function history(): { m1: string; m2: string; directB: string; tip: string } {
    write('a.ts', '1\n');
    write('b.ts', '1\n');
    git('add', '.');
    git('commit', '-qm', 'init');
    git('checkout', '-qb', 'pr1');
    write('a.ts', '2\n');
    git('commit', '-qam', 'pr1');
    git('checkout', '-q', 'main');
    git('merge', '-q', '--no-ff', 'pr1', '-m', 'M1');
    const m1 = git('rev-parse', 'HEAD');
    git('checkout', '-qb', 'pr2');
    write('a.ts', '3\n');
    git('commit', '-qam', 'pr2');
    git('checkout', '-q', 'main');
    write('b.ts', 'x\n');
    git('commit', '-qam', 'direct-b');
    const directB = git('rev-parse', 'HEAD');
    git('merge', '-q', '--no-ff', 'pr2', '-m', 'M2');
    const m2 = git('rev-parse', 'HEAD');
    write('b.ts', 'y\n');
    git('commit', '-qam', 'direct-b2');
    return { m1, m2, directB, tip: git('rev-parse', 'HEAD') };
  }

  it('lists the first-parent descendants of the merge commit, oldest first', () => {
    const { m1, m2, directB, tip } = history();
    expect(listMainDescendants(m1, 'main', repo)).toEqual([directB, m2, tip]);
  });

  it('a later merge that brought another PR edit of the file is listed as a merge', () => {
    const { m1, m2, tip } = history();
    expect(listPathTouchingMainCommits(m1, tip, ['a.ts'], repo)).toEqual([{ sha: m2, parents: 2 }]);
  });

  it('a direct commit on main that edited the file is listed as a non-merge', () => {
    const { m1, directB, tip } = history();
    const touching = listPathTouchingMainCommits(m1, tip, ['b.ts'], repo) ?? [];
    expect(touching.map((c) => c.parents)).toEqual([1, 1]);
    expect(touching.map((c) => c.sha)).toContain(directB);
  });

  it('an unknown commit yields null, never an empty (vacuous) answer', () => {
    history();
    expect(listPathTouchingMainCommits('f'.repeat(40), 'main', ['a.ts'], repo)).toBeNull();
    expect(listMainDescendants('f'.repeat(40), 'main', repo)).toBeNull();
  });
});

describe('inheritedOnMerge: a late failing run is not blamed on the PR (T14026)', () => {
  const MERGE = '7'.repeat(40);
  const BASE = '1'.repeat(40);
  const job = (sha: string, conclusion: string, over: Partial<CommitCheck> = {}): CommitCheck => ({
    name: 'Doppler secrets (dev)',
    source: 'check-run',
    status: 'completed',
    conclusion,
    headSha: sha,
    id: sha === MERGE ? 20 : 10,
    event: 'push',
    ...over,
  });
  const judge = (merge: CommitCheck, nextMainCommitAt: string | null = null) =>
    inheritedOnMerge(
      ['Doppler secrets (dev)'],
      [merge],
      MERGE,
      [{ sha: BASE, checks: [job(BASE, 'success')] }],
      {},
      nextMainCommitAt,
    );

  it('a first-attempt run on time: the PR introduced the failure', () => {
    expect(judge(job(MERGE, 'failure', { runAttempt: 1 }))).toEqual({
      ok: false,
      reason: expect.stringMatching(
        /success on its base 111111111111 — the PR introduced this failure$/,
      ),
    });
  });

  it("a re-run refuses, but says the failure may not be the PR's", () => {
    const r = judge(job(MERGE, 'failure', { runAttempt: 2 }));
    expect(r.ok).toBe(false);
    expect(!r.ok && r.reason).toMatch(
      /the failing run is re-run attempt 2, so it may have failed on something that changed after the merge/,
    );
    expect(!r.ok && r.reason).not.toMatch(/the PR introduced/);
  });

  it('a run started after a later default-branch commit landed refuses without blaming the PR', () => {
    const r = judge(
      job(MERGE, 'failure', { startedAt: '2026-10-20T00:00:00Z' }),
      '2026-08-01T00:00:00Z',
    );
    expect(!r.ok && r.reason).toMatch(
      /started at 2026-10-20T00:00:00Z, after a later default-branch commit landed \(2026-08-01T00:00:00Z\)/,
    );
    expect(!r.ok && r.reason).not.toMatch(/the PR introduced/);
  });
});

/**
 * Projects with GitHub workflows but no evidence.ciSatisfies were told only to
 * run a full suite after a merge (T13096). The remedy names the block to add,
 * with the default branch's required checks.
 */
describe('ciSatisfiesRemedy (T13096)', () => {
  let dir: string;
  const write = (rel: string, body: string) => {
    mkdirSync(join(dir, rel, '..'), { recursive: true });
    writeFileSync(join(dir, rel), body);
  };
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'ci-remedy-'));
    delete process.env[PR_REQUIRED_WORKFLOWS_ENV_VAR];
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it('is null without workflows, or when ciSatisfies is already set', async () => {
    write('.cleo/project-context.json', '{}');
    expect(await ciSatisfiesRemedy(dir)).toBeNull();
    write('.github/workflows/ci.yml', 'on: push\n');
    write('.cleo/project-context.json', JSON.stringify({ evidence: { ciSatisfies: true } }));
    expect(await ciSatisfiesRemedy(dir)).toBeNull();
  });

  it('names a ready-to-paste block from branch protection when the setting is off', async () => {
    write('.github/workflows/ci.yml', 'on: push\n');
    write('.cleo/project-context.json', '{}');
    const remedy = await ciSatisfiesRemedy(dir, {
      fetchGhBranchProtection: async () => ({
        ok: true,
        contexts: ['CI', 'Lint'],
        repo: 'acme/app',
        branch: 'main',
      }),
    });
    expect(remedy).toContain(
      '"evidence": {"ciSatisfies":true,"ciChecks":{"tests":["CI","Lint"],"qa":["CI","Lint"]}}',
    );
    expect(remedy).toContain('branch protection for acme/app@main');
  });

  it('falls back to a placeholder when no required checks can be found', async () => {
    write('.github/workflows/ci.yml', 'on: push\n');
    write('.cleo/project-context.json', '{}');
    const remedy = await ciSatisfiesRemedy(dir, {
      fetchGhBranchProtection: async () => ({ ok: false, reason: 'no branch protection' }),
    });
    expect(remedy).toContain('"tests":["<required check>"]');
    expect(remedy).toContain('no branch protection');
  });
});
