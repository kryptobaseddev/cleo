/**
 * `ci:<pr>` — required CI green on a merged PR's MERGE COMMIT satisfies
 * testsPassed and qaPassed (owner decision D11149, T12634).
 *
 * Pinned:
 *  1. every required check must be `completed`/`success` on the merge commit;
 *     pending, failed, skipped and missing checks are each refused with a
 *     reason naming the check and its state;
 *  2. a check that ran only on another SHA (the PR head) never counts;
 *  3. the atom is refused unless the project opts in (`evidence.ciSatisfies`);
 *  4. the gate minimum and task-context rules accept a validated `ci:` atom
 *     for testsPassed and qaPassed — and nothing else.
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
  readCiSatisfies,
  resolveCiEvidenceAtom,
} from '../ci-evidence.js';
import type { PrAtomResolution } from '../pr-evidence.js';

const MERGE = 'a'.repeat(40);
const HEAD = 'b'.repeat(40);
const REQUIRED = ['CI', 'Lockfile Check', 'Contracts Dep Lint'];

function check(name: string, extra: Partial<CommitCheck> = {}): CommitCheck {
  return {
    name,
    source: 'check-run',
    status: 'completed',
    conclusion: 'success',
    headSha: MERGE,
    id: 1,
    ...extra,
  };
}

const allGreen: CommitCheck[] = [
  check('CI', { source: 'workflow-run' }),
  check('CI', { id: 2 }),
  check('Lockfile Check', { source: 'workflow-run' }),
  check('Contracts Dep Lint'),
  check('Type Check'),
];

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

  it('never counts a check that ran on another SHA (the PR head)', () => {
    const onHead = allGreen.map((c) => ({ ...c, headSha: HEAD }));
    const r = evaluateMergeCommitChecks(REQUIRED, onHead, MERGE);
    expect(r.ok).toBe(false);
    expect(!r.ok && r.reasons.join('\n')).toMatch(
      new RegExp(`CI.*ran on ${HEAD.slice(0, 12)}, not the merge commit ${MERGE.slice(0, 12)}`),
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
    title: 'T1',
    body: '',
    headRefName: 'task/T1',
    changedPaths: ['a.ts'],
    changedFileCount: 1,
  };

  function enable(value: unknown): void {
    mkdirSync(join(root, '.cleo'), { recursive: true });
    writeFileSync(
      join(root, '.cleo', 'project-context.json'),
      JSON.stringify({ evidence: { ciSatisfies: value } }),
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
    const r = await resolveCiEvidenceAtom(
      42,
      { storeRoot: root, executionRoot: root },
      {
        resolvePr: async () => merged,
        fetchChecks: async () => ({ ok: true, checks: allGreen }),
      },
    );
    expect(r.ok).toBe(false);
    expect(!r.ok && r.reason).toMatch(/evidence\.ciSatisfies/);
  });

  it('only `true` enables it', () => {
    enable('yes');
    expect(readCiSatisfies(root)).toBe(false);
    enable(true);
    expect(readCiSatisfies(root)).toBe(true);
  });

  it('accepts green merge-commit CI and records the checks and the merge commit', async () => {
    enable(true);
    let queried = '';
    const r = await resolveCiEvidenceAtom(
      42,
      { storeRoot: root, executionRoot: root },
      {
        resolvePr: async () => merged,
        fetchChecks: async (sha) => {
          queried = sha;
          return { ok: true, checks: allGreen };
        },
      },
    );
    expect(queried).toBe(MERGE);
    expect(r.ok).toBe(true);
    const atom = r.ok ? r.atom : null;
    expect(atom).toMatchObject({ kind: 'ci', prNumber: 42, mergeCommitSha: MERGE });
    expect(atom?.kind === 'ci' && atom.checks.length).toBe(3);
  });

  it('refuses an unmerged PR through the pr: provenance result', async () => {
    enable(true);
    const r = await resolveCiEvidenceAtom(
      42,
      { storeRoot: root, executionRoot: root },
      {
        resolvePr: async () => ({
          ok: false,
          reason: 'PR #42 is in state OPEN',
          codeName: 'E_EVIDENCE_INSUFFICIENT',
        }),
        fetchChecks: async () => ({ ok: true, checks: allGreen }),
      },
    );
    expect(!r.ok && r.reason).toMatch(/OPEN/);
  });

  it('refuses failing merge-commit CI with E_EVIDENCE_TESTS_FAILED', async () => {
    enable(true);
    const r = await resolveCiEvidenceAtom(
      42,
      { storeRoot: root, executionRoot: root },
      {
        resolvePr: async () => merged,
        fetchChecks: async () => ({
          ok: true,
          checks: allGreen.map((c) => (c.name === 'CI' ? { ...c, conclusion: 'failure' } : c)),
        }),
      },
    );
    expect(r.ok).toBe(false);
    expect(!r.ok && r.codeName).toBe('E_EVIDENCE_TESTS_FAILED');
  });
});

describe('tree-equal PR runs (merge commit and PR head carry the same tree)', () => {
  const TREE = 'c'.repeat(40);
  let root: string;
  const merged: PrAtomResolution = {
    ok: true,
    prNumber: 42,
    mergeCommitSha: MERGE,
    mergedAt: '2026-09-28T00:00:00Z',
    successCount: 3,
    totalChecks: 3,
    cacheHit: false,
    title: 'T1',
    body: '',
    headRefName: 'task/T1',
    headRefOid: HEAD,
    changedPaths: ['a.ts'],
    changedFileCount: 1,
  };
  const onHead = allGreen.map((c) => ({ ...c, headSha: HEAD }));
  const cancelledOnMerge = allGreen.map((c) =>
    c.name === 'CI' ? { ...c, conclusion: 'cancelled' } : c,
  );

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'ci-tree-'));
    mkdirSync(join(root, '.cleo'), { recursive: true });
    writeFileSync(
      join(root, '.cleo', 'project-context.json'),
      JSON.stringify({ evidence: { ciSatisfies: true } }),
    );
    process.env[PR_REQUIRED_WORKFLOWS_ENV_VAR] = REQUIRED.join(',');
  });
  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
    delete process.env[PR_REQUIRED_WORKFLOWS_ENV_VAR];
  });

  function resolveWith(checksBySha: Record<string, CommitCheck[]>, trees: Record<string, string>) {
    return resolveCiEvidenceAtom(
      42,
      { storeRoot: root, executionRoot: root },
      {
        resolvePr: async () => merged,
        fetchChecks: async (sha) => ({ ok: true, checks: checksBySha[sha] ?? [] }),
        treeOf: (sha) => trees[sha] ?? null,
      },
    );
  }

  it('accepts required checks that succeeded on the PR head when its tree equals the merge tree', async () => {
    const r = await resolveWith({ [MERGE]: [], [HEAD]: onHead }, { [MERGE]: TREE, [HEAD]: TREE });
    expect(r.ok, JSON.stringify(r)).toBe(true);
    if (!r.ok) return;
    expect(r.atom.testedTree).toBe(TREE);
    expect(r.atom.checks.every((c) => c.sha === HEAD)).toBe(true);
  });

  it('refuses PR-head checks when the trees differ, falling back to merge-commit checks', async () => {
    const r = await resolveWith(
      { [MERGE]: [], [HEAD]: onHead },
      { [MERGE]: TREE, [HEAD]: 'd'.repeat(40) },
    );
    expect(r.ok).toBe(false);
    expect(!r.ok && r.reason).toMatch(/not found on merge commit/);
  });

  it('a cancelled main push run is covered by a tree-equal PR run', async () => {
    const r = await resolveWith(
      { [MERGE]: cancelledOnMerge, [HEAD]: onHead },
      { [MERGE]: TREE, [HEAD]: TREE },
    );
    expect(r.ok, JSON.stringify(r)).toBe(true);
    if (!r.ok) return;
    const bySha = Object.fromEntries(r.atom.checks.map((c) => [c.name, c.sha]));
    expect(bySha).toEqual({ CI: HEAD, 'Lockfile Check': MERGE, 'Contracts Dep Lint': MERGE });
  });

  it('the same cancelled run with a tree-different PR head stays refused', async () => {
    const r = await resolveWith(
      { [MERGE]: cancelledOnMerge, [HEAD]: onHead },
      { [MERGE]: TREE, [HEAD]: 'd'.repeat(40) },
    );
    expect(!r.ok && r.reason).toMatch(/CI: cancelled on merge commit/);
  });

  it('an unknown tree (object not local) never counts as equal', async () => {
    const r = await resolveWith({ [MERGE]: [], [HEAD]: onHead }, { [MERGE]: TREE });
    expect(r.ok).toBe(false);
    // Neither object local: two unknowns are not two equal trees.
    const neither = await resolveWith({ [MERGE]: [], [HEAD]: onHead }, {});
    expect(neither.ok).toBe(false);
  });
});

describe('gate rules accept a validated ci: atom for testsPassed and qaPassed only', () => {
  it('parses ci:<pr>', () => {
    expect(parseEvidence('ci:42').atoms).toEqual([{ kind: 'ci', prNumber: 42 }]);
    expect(() => parseEvidence('ci:abc')).toThrow();
  });

  it('satisfies the testsPassed and qaPassed minimums, not implemented', () => {
    expect(validateEvidenceForGate('testsPassed', [{ kind: 'ci' }]).ok).toBe(true);
    expect(validateEvidenceForGate('qaPassed', [{ kind: 'ci' }]).ok).toBe(true);
    expect(validateEvidenceForGate('implemented', [{ kind: 'ci' }]).ok).toBe(false);
  });

  it('counts as an actual verification result for a code task', () => {
    const context: EvidenceValidationContext = {
      task: { id: 'T1', kind: 'work', labels: [], files: [], acceptance: [] },
      gates: ['testsPassed'],
      criteria: [],
    };
    const ci: EvidenceAtom = {
      kind: 'ci',
      prNumber: 42,
      mergeCommitSha: MERGE,
      checks: [{ name: 'CI', conclusion: 'success', sha: MERGE }],
      requiredSource: 'env',
    };
    expect(checkTaskEvidenceContext(context, 'testsPassed', [ci])).toBeNull();
    expect(checkTaskEvidenceContext(context, 'qaPassed', [ci])).toBeNull();
    expect(checkTaskEvidenceContext(context, 'testsPassed', [])).not.toBeNull();
  });
});
