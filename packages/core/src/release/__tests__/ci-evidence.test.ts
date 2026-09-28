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
  type ResolveCiEvidenceOptions,
  readCiSatisfies,
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

  it('refuses a PR that edits a pinned workflow file (round 2 #2)', async () => {
    writeContext(optedIn);
    const r = await resolve({
      resolvePr: async () => ({
        ...merged,
        changedPaths: ['a.ts', '.github/workflows/ci.yml'],
        changedFileCount: 2,
      }),
    });
    expect(!r.ok && r.reason).toMatch(/edits the pinned workflow \.github\/workflows\/ci\.yml/);
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

    it('docs task with Unit Tests skipped: accepted (an honest skip)', async () => {
      const docs: EvidenceValidationContext = {
        ...context(),
        task: { ...context().task, labels: ['docs'] },
      };
      const r = await resolve({
        context: docs,
        fetchChecks: async () => ({ ok: true, checks: unitSkipped }),
      });
      expect(r.ok, JSON.stringify(r)).toBe(true);
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
