/**
 * Component PRs landed by an integration PR (T12671, T12672): the one place
 * that verifies the relationship and derives the component's files, shared by
 * `pr:`/`ci:` validation and the change set.
 *
 * @task T12671
 * @task T12672
 */

import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
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

describe('a change the integration branch undid does not survive (T12671 review HIGH)', () => {
  /** A fresh repo: x.ts and y.ts on main, and an integration/j branch. */
  function repoWith(): string {
    const r = realpathSync(mkdtempSync(join(tmpdir(), 'component-undo-')));
    git(r, ['init', '-q', '-b', 'main']);
    git(r, ['config', 'user.name', 'T']);
    git(r, ['config', 'user.email', 't@e.x']);
    writeFileSync(join(r, 'x.ts'), 'old\n');
    writeFileSync(join(r, 'y.ts'), 'keep\n');
    git(r, ['add', '.']);
    git(r, ['commit', '-q', '-m', 'init']);
    git(r, ['switch', '-q', '-c', 'integration/j']);
    writeFileSync(join(r, 'other.ts'), 'unrelated\n');
    git(r, ['add', '.']);
    git(r, ['commit', '-q', '-m', 'integration work']);
    return r;
  }

  /** Merge task/T960 into integration/j (#10), then run `undo`, then squash-land as #20. */
  function land(r: string, change: () => void, undo: (merge: string) => void) {
    git(r, ['switch', '-q', '-c', 'task/T960']);
    change();
    git(r, ['add', '-A']);
    git(r, ['commit', '-q', '-m', 'T960: work']);
    git(r, ['switch', '-q', 'integration/j']);
    git(r, ['merge', '-q', '--no-ff', '-m', 'Merge #10', 'task/T960']);
    const merge = git(r, ['rev-parse', 'HEAD']);
    undo(merge);
    const tip = git(r, ['rev-parse', 'HEAD']);
    git(r, ['switch', '-q', 'main']);
    git(r, ['merge', '-q', '--squash', 'integration/j']);
    git(r, ['commit', '-q', '-m', 'integration (#20)']);
    return {
      merge,
      landing: {
        prNumber: 20,
        headRefName: 'integration/j',
        headRefOid: tip,
        mergeCommitSha: git(r, ['rev-parse', 'HEAD']),
      },
    };
  }

  const componentView = (merge: string) => async (n: number) => ({
    number: n,
    title: 'T960: work',
    body: '',
    headRefName: 'task/T960',
    baseRefName: 'integration/j',
    state: 'MERGED',
    mergeCommitSha: merge,
  });

  it('a component reverted on the integration branch is refused, though its path still exists', async () => {
    const r = repoWith();
    try {
      const { merge, landing } = land(
        r,
        () => writeFileSync(join(r, 'x.ts'), 'new\n'),
        (m) => git(r, ['revert', '--no-edit', '-m', '1', m]),
      );
      const res = await resolveComponentPr(10, landing, r, componentView(merge));
      expect(res.ok).toBe(false);
      expect(!res.ok && res.reason).toMatch(/None of component PR #10's changes survive/);
    } finally {
      rmSync(r, { recursive: true, force: true });
    }
  });

  it('a deletion the integration branch restored is refused', async () => {
    const r = repoWith();
    try {
      const { merge, landing } = land(
        r,
        () => git(r, ['rm', '-q', 'y.ts']),
        () => {
          writeFileSync(join(r, 'y.ts'), 'keep\n');
          git(r, ['add', 'y.ts']);
          git(r, ['commit', '-q', '-m', 'restore y.ts']);
        },
      );
      const res = await resolveComponentPr(10, landing, r, componentView(merge));
      expect(res.ok).toBe(false);
    } finally {
      rmSync(r, { recursive: true, force: true });
    }
  });

  it('a file a later change also edited is credited while its own hunks still apply (T12689)', async () => {
    const r = repoWith();
    try {
      const long = Array.from({ length: 20 }, (_, i) => `line ${i}`).join('\n');
      writeFileSync(join(r, 'x.ts'), `${long}\n`);
      git(r, ['commit', '-q', '-am', 'long x.ts']);
      const { merge, landing } = land(
        r,
        () => writeFileSync(join(r, 'x.ts'), `${long.replace('line 1\n', 'line ONE\n')}\n`),
        () => {
          // Another component edits the far end of the same file.
          const now = readFileSync(join(r, 'x.ts'), 'utf-8');
          writeFileSync(join(r, 'x.ts'), now.replace('line 19', 'line NINETEEN'));
          git(r, ['commit', '-q', '-am', 'later edit to x.ts']);
        },
      );
      const res = await resolveComponentPr(10, landing, r, componentView(merge));
      expect(res.ok && res.files).toEqual(['x.ts']);
    } finally {
      rmSync(r, { recursive: true, force: true });
    }
  });

  it('a reverted change is not credited when an identical block exists elsewhere (T12689 review MED)', async () => {
    const r = repoWith();
    try {
      const lines = Array.from({ length: 30 }, (_, i) => `line ${i}`);
      writeFileSync(join(r, 'x.ts'), `${lines.join('\n')}\n`);
      git(r, ['commit', '-q', '-am', 'thirty lines']);
      const changed = lines.map((l, i) => (i === 15 ? 'line FIFTEEN' : l));
      const { merge, landing } = land(
        r,
        () => writeFileSync(join(r, 'x.ts'), `${changed.join('\n')}\n`),
        (m) => {
          // The integration branch reverts the component…
          git(r, ['revert', '--no-edit', '-m', '1', m]);
          // …then a later commit appends a block identical to the changed hunk.
          const block = changed.slice(12, 19).join('\n');
          writeFileSync(join(r, 'x.ts'), `${lines.join('\n')}\n${block}\n`);
          git(r, ['commit', '-q', '-am', 'append an identical block']);
        },
      );
      const res = await resolveComponentPr(10, landing, r, componentView(merge));
      // Line 15 is back to the original: nothing of the component survives.
      expect(res.ok).toBe(false);
    } finally {
      rmSync(r, { recursive: true, force: true });
    }
  });

  it('a deletion-only component is credited with its deletions (T12689)', async () => {
    const r = repoWith();
    try {
      const { merge, landing } = land(
        r,
        () => git(r, ['rm', '-q', 'y.ts']),
        () => undefined,
      );
      const res = await resolveComponentPr(10, landing, r, componentView(merge));
      expect(res).toMatchObject({ ok: true, files: [], deleted: ['y.ts'] });
    } finally {
      rmSync(r, { recursive: true, force: true });
    }
  });

  it('a change a later commit overwrote is not counted; the untouched one is', async () => {
    const r = repoWith();
    try {
      const { merge, landing } = land(
        r,
        () => {
          writeFileSync(join(r, 'x.ts'), 'new\n');
          writeFileSync(join(r, 'z.ts'), 'added\n');
        },
        () => {
          writeFileSync(join(r, 'x.ts'), 'someone else\n');
          git(r, ['commit', '-q', '-am', 'overwrite x.ts']);
        },
      );
      const res = await resolveComponentPr(10, landing, r, componentView(merge));
      expect(res.ok && res.files).toEqual(['z.ts']);
    } finally {
      rmSync(r, { recursive: true, force: true });
    }
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
    // The component's surviving file plus its deletion (T12689: deletions are changes).
    expect(linked.ok && linked.pr.changedPaths).toEqual(['a.ts', 'old.ts']);
    expect(linked.ok && linked.pr.deletedPaths).toEqual(['old.ts']);
    expect(linked.ok && checkPrTaskLinkage(linked.prNumber, linked.pr, ctx)).toBeNull();
  });
});
