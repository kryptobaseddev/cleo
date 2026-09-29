/**
 * `cleo done --pr <component>` follows a component PR to the integration PR
 * that landed it (T12671, T12710).
 *
 * The fixtures are real git repositories with a real `origin`: an integration
 * branch that `--no-ff` merges several task branches and is itself `--no-ff`
 * merged into main, and a rebased batch whose commits are cherry-picks. Only
 * `gh` is stubbed. The four field shapes from T12710:
 *
 *  1. a component GitHub marked MERGED because its commits reached main — its
 *     "merge commit" is the merge INTO the integration branch (#1669, #1671);
 *  2. a component closed by hand whose head later merged main, so the head is
 *     not an ancestor of main (#1658);
 *  3. a component stacked on another component, closed (#1668);
 *  4. a rebased batch: no component commit is on main; patch-id maps it.
 *
 * And the safety side: a component whose change is not in the landed
 * integration is never credited.
 *
 * @task T12671
 * @task T12710
 */

import { execFileSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { PrAtomResolution } from '../../release/pr-evidence.js';
import {
  type ChangeSetDeps,
  type ChangeSetTask,
  deriveTaskChangeSet,
  type PrDetails,
} from '../change-set.js';
import {
  type ComponentLandingDeps,
  type ComponentPrView,
  defaultComponentLandingDeps,
  findComponentLanding,
  type LandingCandidate,
  landingCommitOn,
  resolveComponentPr,
} from '../component-pr.js';
import { parseEvidence, validateAtom } from '../evidence.js';

function git(dir: string, args: string[]): string {
  return execFileSync('git', args, { cwd: dir, encoding: 'utf-8' }).trim();
}

function commitFile(dir: string, path: string, text: string, message: string): string {
  writeFileSync(join(dir, path), text);
  git(dir, ['add', '-A']);
  git(dir, ['commit', '-q', '-m', message]);
  return git(dir, ['rev-parse', 'HEAD']);
}

let base: string;
let repo: string;

/**
 * main ← #20 (`--no-ff` merge of integration/x), which `--no-ff` merged:
 * task/T1 (#11), task/T2 (#12) and task/T3 (#13, stacked on task/T2).
 * Afterwards task/T2 merged main into its head.
 */
interface Fixture {
  c1: string;
  m1: string;
  c2: string;
  h2: string;
  c3: string;
  intTip: string;
  landing: string;
}

function buildFixture(): Fixture {
  const origin = join(base, 'origin.git');
  repo = join(base, 'repo');
  execFileSync('git', ['init', '-q', '--bare', '-b', 'main', origin]);
  mkdirSync(repo, { recursive: true });
  git(repo, ['init', '-q', '-b', 'main']);
  git(repo, ['config', 'user.name', 'T']);
  git(repo, ['config', 'user.email', 't@e.x']);
  commitFile(repo, 'a.ts', 'export const a = 1;\n', 'init');
  git(repo, ['remote', 'add', 'origin', origin]);
  git(repo, ['push', '-q', '-u', 'origin', 'main']);
  git(repo, ['remote', 'set-head', 'origin', 'main']);
  repo = realpathSync(repo);

  git(repo, ['switch', '-q', '-c', 'task/T1']);
  writeFileSync(join(repo, 'a.ts'), 'export const a = 2;\n');
  const c1 = commitFile(repo, 't1.ts', 'export const t1 = 1;\n', 'T1: work');
  git(repo, ['switch', '-q', 'main']);
  git(repo, ['switch', '-q', '-c', 'task/T2']);
  const c2 = commitFile(repo, 't2.ts', 'export const t2 = 1;\n', 'T2: work');
  git(repo, ['switch', '-q', '-c', 'task/T3']);
  const c3 = commitFile(repo, 't3.ts', 'export const t3 = 1;\n', 'T3: work on T2');

  git(repo, ['switch', '-q', 'main']);
  git(repo, ['switch', '-q', '-c', 'integration/x']);
  commitFile(repo, 'int.ts', 'export const i = 1;\n', 'integration work');
  git(repo, ['merge', '-q', '--no-ff', '-m', 'Merge task/T1', 'task/T1']);
  const m1 = git(repo, ['rev-parse', 'HEAD']);
  git(repo, ['merge', '-q', '--no-ff', '-m', 'Merge task/T2', 'task/T2']);
  git(repo, ['merge', '-q', '--no-ff', '-m', 'Merge task/T3', 'task/T3']);
  const intTip = git(repo, ['rev-parse', 'HEAD']);
  git(repo, ['switch', '-q', 'main']);
  git(repo, ['merge', '-q', '--no-ff', '-m', 'Merge pull request #20', 'integration/x']);
  const landing = git(repo, ['rev-parse', 'HEAD']);
  git(repo, ['push', '-q', 'origin', 'main']);

  // #1658: the component's head merged main after it landed.
  git(repo, ['switch', '-q', 'task/T2']);
  git(repo, ['merge', '-q', '--no-ff', '-m', 'Merge main into T2', 'main']);
  const h2 = git(repo, ['rev-parse', 'HEAD']);
  git(repo, ['switch', '-q', 'main']);
  return { c1, m1, c2, h2, c3, intTip, landing };
}

function details(number: number, extra: Partial<PrDetails> = {}): PrDetails {
  return {
    number,
    title: `T${number}: work`,
    headRefName: `task/T${number}`,
    baseRefName: 'main',
    state: 'CLOSED',
    mergedAt: null,
    headRefOid: null,
    mergeCommitSha: null,
    ...extra,
  };
}

function candidate(number: number, mergeCommitSha: string, body = ''): LandingCandidate {
  return {
    number,
    headRefName: `integration/${number}`,
    baseRefName: 'main',
    state: 'MERGED',
    headRefOid: null,
    mergeCommitSha,
    body,
  };
}

function landingDeps(byMerge: Record<string, number>, listing: LandingCandidate[] = []) {
  const calls: string[] = [];
  const deps: ComponentLandingDeps = {
    prsByMergeCommit: async (sha) => {
      calls.push(`merge:${sha}`);
      const n = byMerge[sha];
      return { ok: true, prs: n === undefined ? [] : [candidate(n, sha)] };
    },
    prsListingComponent: async (n) => {
      calls.push(`listing:${n}`);
      return { ok: true, prs: listing };
    },
  };
  return { deps, calls };
}

function task(id: string): ChangeSetTask {
  return { id, kind: 'work', labels: [], files: undefined, acceptance: [] };
}

/** Change-set deps for one component PR; the component's own pr:/CI is never consulted. */
function changeSetDeps(
  views: Record<number, PrDetails>,
  landing: ComponentLandingDeps,
  extra: Partial<ChangeSetDeps> = {},
): ChangeSetDeps & { resolved: number[] } {
  const resolved: number[] = [];
  return {
    resolved,
    listMergedPrs: async () => ({ ok: true, prs: [] }),
    viewPr: async (n) => views[n] ?? null,
    findPrByHead: async () => null,
    resolvePr: async (n): Promise<PrAtomResolution> => {
      resolved.push(n);
      return {
        ok: false,
        codeName: 'E_EVIDENCE_TESTS_FAILED',
        reason: `PR #${n}'s own CI is incomplete`,
      };
    },
    listTaskDocs: async () => [],
    listTaskDecisions: async () => [],
    landing,
    env: {},
    ...extra,
  };
}

beforeEach(() => {
  base = realpathSync(mkdtempSync(join(tmpdir(), 'component-landing-')));
});

afterEach(() => rmSync(base, { recursive: true, force: true }));

describe('landingCommitOn', () => {
  it("names the first-parent commit on main that landed a commit, or the commit itself when it is on main's chain", () => {
    const f = buildFixture();
    expect(landingCommitOn(repo, f.c1, 'origin/main')).toBe(f.landing);
    expect(landingCommitOn(repo, f.m1, 'origin/main')).toBe(f.landing);
    expect(landingCommitOn(repo, f.landing, 'origin/main')).toBe(f.landing);
    expect(landingCommitOn(repo, f.h2, 'origin/main')).toBeNull();
  });
});

describe('the four T12710 shapes resolve to the integration PR (change set)', () => {
  it('1. a component GitHub marked MERGED, whose merge commit sits inside the integration branch (#1669/#1671)', async () => {
    const f = buildFixture();
    const { deps } = landingDeps({ [f.landing]: 20 });
    const cs = changeSetDeps(
      {
        11: details(11, {
          state: 'MERGED',
          mergeCommitSha: f.m1,
          headRefOid: f.c1,
          commits: [f.c1],
        }),
      },
      deps,
    );
    const out = await deriveTaskChangeSet(
      { task: task('T11'), storeRoot: repo, cwd: repo, prNumber: 11 },
      cs,
    );
    expect(out.blockers).toEqual([]);
    expect(out.prNumber).toBe(20);
    expect(out.componentPrNumber).toBe(11);
    expect(out.mergeCommitSha).toBe(f.landing);
    expect(out.mergeState).toBe('merged');
    expect(out.files).toEqual(['a.ts', 't1.ts']);
    expect(out.implementedEvidence).toBe('pr:11@20;files:a.ts,t1.ts');
    // The component's own (incomplete) CI is never the evidence.
    expect(cs.resolved).toEqual([]);
    const filesAtom = parseEvidence(out.implementedEvidence ?? '').atoms.find(
      (a) => a.kind === 'files',
    );
    expect((await validateAtom(filesAtom!, repo, undefined, f.landing)).ok).toBe(true);
  });

  it('2. a component closed by hand whose head later merged main, so the head is not on main (#1658)', async () => {
    const f = buildFixture();
    const { deps } = landingDeps({ [f.landing]: 20 });
    const out = await deriveTaskChangeSet(
      { task: task('T12'), storeRoot: repo, cwd: repo, prNumber: 12 },
      changeSetDeps({ 12: details(12, { headRefOid: f.h2, commits: [f.c2, f.h2] }) }, deps),
    );
    expect(out.blockers).toEqual([]);
    expect(out.implementedEvidence).toBe('pr:12@20;files:t2.ts');
  });

  it('3. a component stacked on another component and closed (#1668): not pr-stacked', async () => {
    const f = buildFixture();
    const { deps } = landingDeps({ [f.landing]: 20 });
    const out = await deriveTaskChangeSet(
      { task: task('T13'), storeRoot: repo, cwd: repo, prNumber: 13 },
      changeSetDeps({ 13: details(13, { baseRefName: 'task/T2', commits: [f.c3] }) }, deps, {
        findPrByHead: async () => details(12, { headRefName: 'task/T2', headRefOid: f.h2 }),
      }),
    );
    expect(out.blockers).toEqual([]);
    expect(out.stackedOn).toBeUndefined();
    // Only its own commit's file — not t2.ts from the component below it.
    expect(out.implementedEvidence).toBe('pr:13@20;files:t3.ts');
  });

  it('4. a rebased batch: no component commit is on main, patch-id maps it; the body is only a hint', async () => {
    const f = buildFixture();
    git(repo, ['switch', '-q', '-c', 'task/T4']);
    const c4 = commitFile(repo, 't4.ts', 'export const t4 = 1;\n', 'T4: work');
    git(repo, ['switch', '-q', 'main']);
    git(repo, ['switch', '-q', '-c', 'integration/y']);
    commitFile(repo, 'y.ts', 'export const y = 1;\n', 'integration y work');
    git(repo, ['cherry-pick', c4]);
    git(repo, ['switch', '-q', 'main']);
    git(repo, ['merge', '-q', '--no-ff', '-m', 'Merge pull request #40', 'integration/y']);
    const landing40 = git(repo, ['rev-parse', 'HEAD']);
    git(repo, ['push', '-q', 'origin', 'main']);
    expect(landing40).not.toBe(f.landing);

    const { deps, calls } = landingDeps({}, [
      // #310 is not #31, and #20 lists #31 but did not land it.
      candidate(41, landing40, '| #310 | T9 |'),
      candidate(20, f.landing, '| #31 | T4 |'),
      candidate(40, landing40, '| PR | Task |\n|---|---|\n| #31 | T4 |'),
    ]);
    const out = await deriveTaskChangeSet(
      { task: task('T31'), storeRoot: repo, cwd: repo, prNumber: 31 },
      changeSetDeps({ 31: details(31, { headRefOid: c4, commits: [c4] }) }, deps),
    );
    expect(calls).toEqual(['listing:31']);
    expect(out.blockers).toEqual([]);
    expect(out.prNumber).toBe(40);
    expect(out.mergeCommitSha).toBe(landing40);
    expect(out.implementedEvidence).toBe('pr:31@40;files:t4.ts');
  });
});

describe('never credit a component whose change is not in the landed integration', () => {
  it('a body that lists the component while the integration carries a different change is refused', async () => {
    buildFixture();
    git(repo, ['switch', '-q', '-c', 'task/T5']);
    const c5 = commitFile(repo, 't5.ts', 'export const t5 = 1;\n', 'T5: work');
    git(repo, ['switch', '-q', 'main']);
    git(repo, ['switch', '-q', '-c', 'integration/z']);
    commitFile(repo, 't5.ts', 'export const t5 = 999;\n', 'something else');
    git(repo, ['switch', '-q', 'main']);
    git(repo, ['merge', '-q', '--no-ff', '-m', 'Merge pull request #50', 'integration/z']);
    const landing50 = git(repo, ['rev-parse', 'HEAD']);
    git(repo, ['push', '-q', 'origin', 'main']);

    const { deps } = landingDeps({}, [candidate(50, landing50, '| #32 | T5 |')]);
    const view: ComponentPrView = {
      number: 32,
      title: 'T5: work',
      body: '',
      headRefName: 'task/T5',
      baseRefName: 'main',
      state: 'CLOSED',
      mergeCommitSha: null,
      headRefOid: c5,
      commits: [c5],
    };
    const found = await findComponentLanding(repo, view, 'origin/main', deps);
    expect(found).toMatchObject({ ok: false, codeName: 'E_EVIDENCE_CONTENT_MISMATCH' });
    expect(found?.ok === false && found.reason).toMatch(/not in PR #50's merge/);

    // The pr:/ci: validator refuses the same claim.
    const r = await resolveComponentPr(
      32,
      { prNumber: 50, headRefName: 'integration/z', headRefOid: null, mergeCommitSha: landing50 },
      repo,
      async () => view,
    );
    expect(r).toMatchObject({ ok: false, codeName: 'E_EVIDENCE_CONTENT_MISMATCH' });

    // And the change set leaves the refusal visible instead of crediting #50.
    const out = await deriveTaskChangeSet(
      { task: task('T32'), storeRoot: repo, cwd: repo, prNumber: 32 },
      changeSetDeps({ 32: details(32, { headRefOid: c5, commits: [c5] }) }, deps),
    );
    expect(out.implementedEvidence).toBeNull();
    expect(out.componentPrNumber).toBeUndefined();
    expect(out.warnings.join('\n')).toMatch(/not followed to an integration PR/);
  });

  it('a component the integration branch reverted before landing is refused', async () => {
    buildFixture();
    git(repo, ['switch', '-q', '-c', 'task/T6']);
    const c6 = commitFile(repo, 't6.ts', 'export const t6 = 1;\n', 'T6: work');
    git(repo, ['switch', '-q', 'main']);
    git(repo, ['switch', '-q', '-c', 'integration/r']);
    git(repo, ['merge', '-q', '--no-ff', '-m', 'Merge task/T6', 'task/T6']);
    git(repo, ['rm', '-q', 't6.ts']);
    git(repo, ['commit', '-q', '-m', 'undo T6']);
    commitFile(repo, 'r.ts', 'export const r = 1;\n', 'other work');
    git(repo, ['switch', '-q', 'main']);
    git(repo, ['merge', '-q', '--no-ff', '-m', 'Merge pull request #60', 'integration/r']);
    const landing60 = git(repo, ['rev-parse', 'HEAD']);
    git(repo, ['push', '-q', 'origin', 'main']);

    const { deps } = landingDeps({ [landing60]: 60 });
    const found = await findComponentLanding(
      repo,
      {
        number: 33,
        title: 'T6: work',
        body: '',
        headRefName: 'task/T6',
        baseRefName: 'main',
        state: 'CLOSED',
        mergeCommitSha: null,
        commits: [c6],
      },
      'origin/main',
      deps,
    );
    expect(found).toMatchObject({ ok: false, codeName: 'E_EVIDENCE_CONTENT_MISMATCH' });
    expect(found?.ok === false && found.reason).toMatch(
      /None of component PR #33's changes survive/,
    );
  });

  it('a component already on main before the integration PR is not credited to it', async () => {
    const f = buildFixture();
    // c1 landed through #20; a later integration PR merely contains it.
    git(repo, ['switch', '-q', '-c', 'integration/later']);
    commitFile(repo, 'later.ts', 'export const l = 1;\n', 'later work');
    git(repo, ['switch', '-q', 'main']);
    git(repo, ['merge', '-q', '--no-ff', '-m', 'Merge pull request #70', 'integration/later']);
    const landing70 = git(repo, ['rev-parse', 'HEAD']);
    const r = await resolveComponentPr(
      11,
      {
        prNumber: 70,
        headRefName: 'integration/later',
        headRefOid: null,
        mergeCommitSha: landing70,
      },
      repo,
      async () => ({
        number: 11,
        title: 'T1: work',
        body: '',
        headRefName: 'task/T1',
        baseRefName: 'main',
        state: 'MERGED',
        mergeCommitSha: f.m1,
        commits: [f.c1],
      }),
    );
    expect(r).toMatchObject({ ok: false, codeName: 'E_EVIDENCE_CONTENT_MISMATCH' });
    expect(!r.ok && r.reason).toMatch(/already on the default branch before PR #70/);
  });

  it('an open component is never followed', async () => {
    const f = buildFixture();
    const { deps, calls } = landingDeps({ [f.landing]: 20 });
    const found = await findComponentLanding(
      repo,
      {
        number: 11,
        title: '',
        body: '',
        headRefName: 'task/T1',
        baseRefName: 'main',
        state: 'OPEN',
        mergeCommitSha: null,
        commits: [f.c1],
      },
      'origin/main',
      deps,
    );
    expect(found).toMatchObject({ ok: false, codeName: 'E_EVIDENCE_INSUFFICIENT' });
    expect(calls).toEqual([]);
  });

  it('a PR merged straight into main is not a component: null, and the change set keeps its own pr:', async () => {
    const f = buildFixture();
    git(repo, ['switch', '-q', '-c', 'task/T7']);
    const c7 = commitFile(repo, 't7.ts', 'export const t7 = 1;\n', 'T7: work');
    git(repo, ['switch', '-q', 'main']);
    git(repo, ['merge', '-q', '--no-ff', '-m', 'Merge pull request #77', 'task/T7']);
    const direct = git(repo, ['rev-parse', 'HEAD']);
    git(repo, ['push', '-q', 'origin', 'main']);
    const { deps, calls } = landingDeps({ [f.landing]: 20 });
    const found = await findComponentLanding(
      repo,
      {
        number: 77,
        title: 'T7: work',
        body: '',
        headRefName: 'task/T7',
        baseRefName: 'main',
        state: 'MERGED',
        mergeCommitSha: direct,
        commits: [c7],
      },
      'origin/main',
      deps,
    );
    expect(found).toBeNull();
    expect(calls).toEqual([]);
  });
});

describe('the pr:/ci: validator accepts the commit-level proof (resolveComponentPr)', () => {
  it('a closed component and a GitHub-marked-merged component both verify against the integration merge', async () => {
    const f = buildFixture();
    const landing = {
      prNumber: 20,
      headRefName: 'integration/x',
      headRefOid: f.intTip,
      mergeCommitSha: f.landing,
    };
    const closed = await resolveComponentPr(12, landing, repo, async () => ({
      number: 12,
      title: 'T12: work',
      body: '',
      headRefName: 'task/T2',
      baseRefName: 'main',
      state: 'CLOSED',
      mergeCommitSha: null,
      headRefOid: f.h2,
      commits: [f.c2, f.h2],
    }));
    expect(closed).toMatchObject({ ok: true, prNumber: 12, files: ['t2.ts'], deleted: [] });
    const marked = await resolveComponentPr(11, landing, repo, async () => ({
      number: 11,
      title: 'T11: work',
      body: '',
      headRefName: 'task/T1',
      baseRefName: 'main',
      state: 'MERGED',
      mergeCommitSha: f.m1,
      commits: [f.c1],
    }));
    expect(marked).toMatchObject({ ok: true, prNumber: 11, files: ['a.ts', 't1.ts'] });
  });
});

describe('gh is bounded and offline is a named refusal', () => {
  it('a gh failure is E_EVIDENCE_TOOL_FAILED, not a hang', async () => {
    const f = buildFixture();
    const found = await findComponentLanding(
      repo,
      {
        number: 12,
        title: '',
        body: '',
        headRefName: 'task/T2',
        baseRefName: 'main',
        state: 'CLOSED',
        mergeCommitSha: null,
        commits: [f.c2],
      },
      'origin/main',
      { prsByMergeCommit: async () => ({ ok: false, reason: 'gh pr list failed (offline)' }) },
    );
    expect(found).toEqual({
      ok: false,
      codeName: 'E_EVIDENCE_TOOL_FAILED',
      reason: 'gh pr list failed (offline)',
    });
  });

  it('the default gh search honours the evidence deadline', async () => {
    const bin = join(base, 'bin');
    mkdirSync(bin);
    writeFileSync(join(bin, 'gh'), '#!/bin/sh\nexec sleep 10\n');
    chmodSync(join(bin, 'gh'), 0o755);
    const savedPath = process.env['PATH'];
    const savedTimeout = process.env['CLEO_GH_TIMEOUT_MS'];
    process.env['PATH'] = `${bin}:${savedPath ?? ''}`;
    process.env['CLEO_GH_TIMEOUT_MS'] = '300';
    try {
      const started = Date.now();
      const r = await defaultComponentLandingDeps.prsByMergeCommit('abc', base);
      expect(Date.now() - started).toBeLessThan(5000);
      expect(r).toMatchObject({ ok: false });
      expect(!r.ok && r.reason).toMatch(/timed out after 300ms/);
    } finally {
      process.env['PATH'] = savedPath;
      if (savedTimeout === undefined) delete process.env['CLEO_GH_TIMEOUT_MS'];
      else process.env['CLEO_GH_TIMEOUT_MS'] = savedTimeout;
    }
  });
});

describe('every git subprocess is bounded (T12710 review)', () => {
  /** A rebased batch: #31's commit c4 was cherry-picked into integration/y (#40). */
  function rebasedFixture() {
    const f = buildFixture();
    git(repo, ['switch', '-q', '-c', 'task/T4']);
    const c4 = commitFile(repo, 't4.ts', 'export const t4 = 1;\n', 'T4: work');
    git(repo, ['switch', '-q', 'main']);
    git(repo, ['switch', '-q', '-c', 'integration/y']);
    commitFile(repo, 'y.ts', 'export const y = 1;\n', 'integration y work');
    git(repo, ['cherry-pick', c4]);
    git(repo, ['switch', '-q', 'main']);
    git(repo, ['merge', '-q', '--no-ff', '-m', 'Merge pull request #40', 'integration/y']);
    const landing40 = git(repo, ['rev-parse', 'HEAD']);
    git(repo, ['push', '-q', 'origin', 'main']);
    const view: ComponentPrView = {
      number: 31,
      title: 'T4: work',
      body: '',
      headRefName: 'task/T4',
      baseRefName: 'main',
      state: 'CLOSED',
      mergeCommitSha: null,
      headRefOid: c4,
      commits: [c4],
    };
    return { f, landing40, view };
  }

  const ENV = [
    'PATH',
    'CLEO_GIT_TIMEOUT_MS',
    'CLEO_COMPONENT_PATCH_MAX_BYTES',
    'CLEO_COMPONENT_SEARCH_BUDGET_MS',
  ] as const;
  const saved: Record<string, string | undefined> = {};
  beforeEach(() => {
    for (const k of ENV) saved[k] = process.env[k];
  });
  afterEach(() => {
    for (const k of ENV) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  });

  it('a git that hangs (log -p / patch-id) is killed at the deadline: E_EVIDENCE_TOOL_FAILED', async () => {
    const { landing40, view } = rebasedFixture();
    const realGit = execFileSync('which', ['git'], { encoding: 'utf-8' }).trim();
    const bin = join(base, 'slow-git');
    mkdirSync(bin);
    writeFileSync(
      join(bin, 'git'),
      `#!/bin/sh\nfor a in "$@"; do\n  case "$a" in log|patch-id) exec sleep 30 ;; esac\ndone\nexec ${realGit} "$@"\n`,
    );
    chmodSync(join(bin, 'git'), 0o755);
    process.env['PATH'] = `${bin}:${saved['PATH'] ?? ''}`;
    process.env['CLEO_GIT_TIMEOUT_MS'] = '400';
    const { deps } = landingDeps({}, [candidate(40, landing40, '| #31 | T4 |')]);
    const started = Date.now();
    const found = await findComponentLanding(repo, view, 'origin/main', deps);
    expect(Date.now() - started).toBeLessThan(10_000);
    expect(found).toMatchObject({ ok: false, codeName: 'E_EVIDENCE_TOOL_FAILED' });
    expect(found?.ok === false && found.reason).toMatch(/timed out after 400ms/);
    const r = await resolveComponentPr(
      31,
      { prNumber: 40, headRefName: 'integration/y', headRefOid: null, mergeCommitSha: landing40 },
      repo,
      async () => view,
    );
    expect(r).toMatchObject({ ok: false, codeName: 'E_EVIDENCE_TOOL_FAILED' });
  });

  it('a candidate whose merge introduces a patch past the size limit is skipped, and says so', async () => {
    const { landing40, view } = rebasedFixture();
    process.env['CLEO_COMPONENT_PATCH_MAX_BYTES'] = '64';
    const { deps } = landingDeps({}, [candidate(40, landing40, '| #31 | T4 |')]);
    const found = await findComponentLanding(repo, view, 'origin/main', deps);
    expect(found).toMatchObject({ ok: false, codeName: 'E_EVIDENCE_INSUFFICIENT' });
    expect(found?.ok === false && found.reason).toMatch(
      /PR #40 skipped: the patch .* exceeds 64 bytes/,
    );
  });

  it('body-hint candidates share one time budget; the rest are skipped, and says so', async () => {
    const { f, landing40, view } = rebasedFixture();
    process.env['CLEO_COMPONENT_SEARCH_BUDGET_MS'] = '1';
    // #50 lists #31 but did not land it; checking it spends the budget, so #40 is skipped.
    const { deps } = landingDeps({}, [
      candidate(50, f.landing, '| #31 | T4 |'),
      candidate(40, landing40, '| #31 | T4 |'),
    ]);
    const found = await findComponentLanding(repo, view, 'origin/main', deps);
    expect(found?.ok).toBe(false);
    expect(found?.ok === false && found.reason).toMatch(/PR #40 skipped: the 1ms candidate budget/);
  });
});
