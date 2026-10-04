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
  evaluateMergeCommitChecks,
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
