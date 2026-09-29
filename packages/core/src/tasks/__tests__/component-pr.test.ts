/**
 * Component PRs landed by an integration PR (T12671, T12672): the one place
 * that verifies the relationship and derives the component's files, shared by
 * `pr:`/`ci:` validation and the change set.
 *
 * @task T12671
 * @task T12672
 */

import { execFileSync } from 'node:child_process';
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { type ComponentPrView, resolveComponentPr } from '../component-pr.js';
import { checkPrTaskLinkage, linkedPrChange } from '../evidence.js';

function git(cwd: string, args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf-8' }).trim();
}

let repo: string;
let componentMerge: string;
let integrationTip: string;
let integrationMerge: string;

beforeEach(() => {
  repo = realpathSync(mkdtempSync(join(tmpdir(), 'component-pr-')));
  git(repo, ['init', '-q', '-b', 'main']);
  git(repo, ['config', 'user.name', 'T']);
  git(repo, ['config', 'user.email', 't@e.x']);
  writeFileSync(join(repo, 'old.ts'), 'export const old = 1;\n');
  git(repo, ['add', '.']);
  git(repo, ['commit', '-q', '-m', 'init']);
  git(repo, ['switch', '-q', '-c', 'integration/i']);
  writeFileSync(join(repo, 'integration-only.ts'), 'export const i = 1;\n');
  git(repo, ['add', '.']);
  git(repo, ['commit', '-q', '-m', 'integration work']);
  git(repo, ['switch', '-q', '-c', 'task/T950']);
  writeFileSync(join(repo, 'a.ts'), 'export const a = 1;\n');
  git(repo, ['rm', '-q', 'old.ts']);
  git(repo, ['add', '.']);
  git(repo, ['commit', '-q', '-m', 'T950: work']);
  git(repo, ['switch', '-q', 'integration/i']);
  git(repo, ['merge', '-q', '--no-ff', '-m', 'Merge #42', 'task/T950']);
  componentMerge = git(repo, ['rev-parse', 'HEAD']);
  integrationTip = componentMerge;
  git(repo, ['switch', '-q', 'main']);
  git(repo, ['merge', '-q', '--squash', 'integration/i']);
  git(repo, ['commit', '-q', '-m', 'integration (#41)']);
  integrationMerge = git(repo, ['rev-parse', 'HEAD']);
});

afterEach(() => rmSync(repo, { recursive: true, force: true }));

function view(extra: Partial<ComponentPrView> = {}) {
  return async (n: number): Promise<ComponentPrView> => ({
    number: n,
    title: 'T950: work',
    body: '',
    headRefName: 'task/T950',
    baseRefName: 'integration/i',
    state: 'MERGED',
    mergeCommitSha: componentMerge,
    ...extra,
  });
}

const landing = () => ({
  prNumber: 41,
  headRefName: 'integration/i',
  headRefOid: integrationTip,
  mergeCommitSha: integrationMerge,
});

describe('resolveComponentPr', () => {
  it("derives only the component's surviving files and deletions", async () => {
    const r = await resolveComponentPr(42, landing(), repo, view());
    expect(r).toMatchObject({ ok: true, prNumber: 42, files: ['a.ts'], deleted: ['old.ts'] });
  });

  it('refuses a component that merged into another branch', async () => {
    const r = await resolveComponentPr(42, landing(), repo, view({ baseRefName: 'main' }));
    expect(!r.ok && r.codeName).toBe('E_EVIDENCE_CONTENT_MISMATCH');
  });

  it('refuses a component the integration head does not contain', async () => {
    const outside = git(repo, ['rev-parse', 'main~1']);
    const r = await resolveComponentPr(42, { ...landing(), headRefOid: outside }, repo, view());
    expect(!r.ok && r.reason).toMatch(/does not contain component PR #42/);
  });

  it('refuses an unmerged component', async () => {
    const r = await resolveComponentPr(42, landing(), repo, view({ state: 'OPEN' }));
    expect(!r.ok && r.codeName).toBe('E_EVIDENCE_INSUFFICIENT');
  });
});

describe('linkedPrChange: the task links through the component, not the integration text', () => {
  const integration = {
    title: 'integration',
    body: 'batch of work',
    headRefName: 'integration/i',
    changedPaths: ['a.ts', 'integration-only.ts', 'old.ts'],
    changedFileCount: 3,
  };
  const ctx = {
    task: { id: 'T950', kind: 'work' as const, labels: [], files: [], acceptance: [] },
    gates: ['implemented' as const],
    criteria: [],
  };

  it('without a component the integration PR must cite the task itself', async () => {
    const linked = await linkedPrChange(
      41,
      { ...integration, headRefOid: integrationTip, mergeCommitSha: integrationMerge },
      { storeRoot: repo, executionRoot: repo },
    );
    expect(linked.ok && checkPrTaskLinkage(linked.prNumber, linked.pr, ctx)?.reason).toMatch(
      /does not establish a relationship to task T950/,
    );
  });

  it("with the component the link holds, and the change is the component's files", async () => {
    const linked = await linkedPrChange(
      41,
      { ...integration, headRefOid: integrationTip, mergeCommitSha: integrationMerge },
      { storeRoot: repo, executionRoot: repo },
      42,
      view(),
    );
    expect(linked.ok).toBe(true);
    expect(linked.ok && linked.pr.changedPaths).toEqual(['a.ts']);
    expect(linked.ok && checkPrTaskLinkage(linked.prNumber, linked.pr, ctx)).toBeNull();
  });
});
