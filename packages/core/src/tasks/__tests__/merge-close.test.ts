/**
 * Merge closes tasks (T14101): a merged PR with green CI on its exact head
 * closes the tasks its body names; red CI, an unmapped criterion or no named
 * task closes nothing and says why; a rerun records nothing twice.
 *
 * The task store, its criteria and the audit rows are real; `gh` and the
 * record/complete path are injected, so no test reaches the network.
 *
 * @task T14101
 */

import { execFileSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { GhPrViewPayload, MergeSweepResult, ReviewVerdict } from '@cleocode/contracts';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { getActiveSessionInfo } from '../../sessions/session-enforcement.js';
import { createTestDb, type TestDbEnv } from '../../store/__tests__/test-db-helper.js';
import { resetDbState } from '../../store/sqlite.js';
import { addTask } from '../add.js';
import {
  acquireMergeSweepLock,
  claimMergeSweep,
  defaultMergeCloseDeps,
  formatMergeReceipt,
  judgeMergedPr,
  lockHolds,
  MERGE_CLOSE_AUDIT_ACTION,
  MERGE_SWEEP_INTERVAL_MS,
  MERGE_SWEEP_LOCK_STALE_MS,
  MERGE_SWEEP_MAX_PAGES,
  MERGE_SWEEP_PR_LIMIT,
  MERGE_WAITING_MAX_AGE_MS,
  type MergeCloseDeps,
  type MergedPrRecord,
  mergeSweepSpawnAllowed,
  parseMergeDirectives,
  stealStaleLock,
  sweepMergedClosures,
  sweepRegisteredProjects,
} from '../merge-close.js';

let env: TestDbEnv;
const HOUR = 60 * 60_000;
let root: string;

beforeEach(async () => {
  env = await createTestDb();
  root = env.tempDir;
  process.env['CLEO_DIR'] = env.cleoDir;
});

afterEach(async () => {
  delete process.env['CLEO_DIR'];
  resetDbState();
  await env.cleanup();
});

const green: GhPrViewPayload['statusCheckRollup'] = [
  { name: 'CI', workflowName: 'CI', conclusion: 'SUCCESS', status: 'COMPLETED' },
];
const red: GhPrViewPayload['statusCheckRollup'] = [
  { name: 'CI', workflowName: 'CI', conclusion: 'FAILURE', status: 'COMPLETED' },
];

function pr(
  number: number,
  body: string,
  rollup = green,
  mergedAt = '2026-10-28T10:00:00Z',
): MergedPrRecord {
  return {
    number,
    body,
    mergedAt,
    headRefOid: `head${number}`.padEnd(40, '0'),
    mergeCommitSha: `merge${number}`.padEnd(40, '0'),
    statusCheckRollup: rollup,
  };
}

async function seedTask(acceptance: string[]): Promise<string> {
  const result = await addTask(
    {
      title: `merge-close fixture ${acceptance.length}`,
      description: 'seeded fixture for the merge sweep',
      // Fixtures are alike on purpose; BRAIN's near-duplicate refusal is not under test.
      forceDuplicate: true,
      acceptance,
      skipContainmentInvariant: true,
    },
    root,
    env.accessor,
  );
  return result.task.id;
}

/** Fake outside world: the PRs gh lists, and a record of every call. */
/** A `met` verdict for every criterion of every PR, on that PR's own head. */
function metOnHead(prs: readonly MergedPrRecord[]): NonNullable<MergeCloseDeps['reviewVerdicts']> {
  return async (_root, taskId, prNumber) => {
    const head = prs.find((p) => p.number === prNumber)?.headRefOid ?? '';
    return Array.from({ length: 9 }, (_, i) =>
      verdict(taskId, prNumber, `AC${i + 1}`, head, 'met'),
    );
  };
}

function verdict(
  taskId: string,
  prNumber: number,
  ac: string,
  headSha: string,
  outcome: 'met' | 'unmet',
  createdAt = '2026-10-28T08:00:00Z',
): ReviewVerdict {
  return {
    id: `${taskId}-${ac}-${headSha}-${createdAt}`,
    taskId,
    ac,
    acId: `${taskId}-${ac}`,
    prNumber,
    headSha,
    verdict: outcome,
    reason: outcome === 'met' ? 'the diff delivers it' : 'the diff does not touch it',
    reviewer: { sessionId: 'ses_reviewer', agentId: 'reviewer' },
    authors: { sessionIds: ['ses_author'], agentIds: ['author'] },
    packetSha256: 'x'.repeat(64),
    createdAt,
  };
}

function fakeDeps(
  prs: MergedPrRecord[],
  issues: Array<{ url: string; title: string }> = [],
  open: MergedPrRecord[] = [],
) {
  /** What the outside world says; tests change it between sweeps. */
  const world = {
    recordRefusal: null as string | null,
    mergeRun: { runId: 77, status: 'completed', conclusion: 'success' } as {
      runId: number;
      status: string;
      conclusion: string | null;
    } | null,
    canRerun: true,
    /** The sweep's clock; tests step it past a backoff. */
    now: Date.now(),
  };
  const calls = {
    reruns: [] as number[],
    statuses: [] as Array<{ sha: string; state: string; description: string }>,
    sessionsAtComplete: [] as Array<string | null>,
    closedIssues: [] as string[],
    record: [] as Array<{ taskId: string; prNumber: number; acs: string[]; dryRun: boolean }>,
    complete: [] as string[],
    comments: [] as Array<{ prNumber: number; body: string }>,
  };
  const deps: MergeCloseDeps = {
    listMergedPrs: async () => prs,
    viewPr: async (_root, n) => prs.find((p) => p.number === n) ?? null,
    comment: async (_root, prNumber, body) => {
      calls.comments.push({ prNumber, body });
      return true;
    },
    requiredChecks: async () => ['CI'],
    ghAvailable: async () => true,
    record: async (_root, taskId, prNumber, acs, dryRun) => {
      calls.record.push({ taskId, prNumber, acs, dryRun });
      return world.recordRefusal === null
        ? { ok: true }
        : { ok: false, reason: world.recordRefusal };
    },
    mergeCiRun: async () => world.mergeRun,
    rerunRun: async (_root, runId) => {
      calls.reruns.push(runId);
      return true;
    },
    canRerun: () => world.canRerun,
    now: () => world.now,
    listLabelledIssues: async () => issues,
    reviewVerdicts: metOnHead([...prs, ...open]),
    listOpenPrs: async () => open,
    setStatus: async (_root, sha, state, description) => {
      calls.statuses.push({ sha, state, description });
      return true;
    },
    closeIssue: async (_root, url) => {
      calls.closedIssues.push(url);
      return true;
    },
    complete: async (_root, taskId) => {
      calls.complete.push(taskId);
      calls.sessionsAtComplete.push((await getActiveSessionInfo(root))?.id ?? null);
      await env.accessor.updateTaskFields(taskId, {
        status: 'done',
        pipelineStage: 'contribution',
      });
      return { ok: true };
    },
  };
  return { deps, calls, world };
}

/** The reason of the first waiting outcome, or a marker when none waits. */
function waitingOn(result: MergeSweepResult): string {
  const waiting = result.prs.flatMap((p) => p.outcomes).find((o) => o.action === 'waiting');
  return waiting?.reason ?? '(nothing waiting)';
}

async function mergeRows(taskId: string) {
  return env.accessor.queryAuditLog({ taskIds: [taskId], actions: [MERGE_CLOSE_AUDIT_ACTION] });
}

describe('PR body lines (T14101)', () => {
  it('parses Closes: and Refs: lines and ignores GitHub issue syntax', () => {
    const body = 'Fixes things.\n\nCloses: T14101 AC1, AC2\nRefs: `T14102 AC3`\nCloses #123\n';
    expect(parseMergeDirectives(body)).toEqual({
      directives: [
        { kind: 'closes', taskId: 'T14101', acs: ['AC1', 'AC2'] },
        { kind: 'refs', taskId: 'T14102', acs: ['AC3'] },
      ],
      errors: [],
    });
  });

  it('refuses a line without criteria, a wildcard, and a task named twice', () => {
    const { errors } = parseMergeDirectives(
      'Closes: T1\nRefs: T2 all\nCloses: T3 AC1\nRefs: T3 AC2',
    );
    expect(errors).toHaveLength(3);
    expect(errors[0]).toMatch(/Closes: T#### AC1,AC2/);
    expect(errors[2]).toMatch(/T3 is named on more than one/);
  });
});

describe('receipt without a task store (T14101)', () => {
  it('a red head, no lines, or malformed lines close nothing and say why', async () => {
    expect((await judgeMergedPr(pr(1, 'Closes: T5 AC1', red), ['CI'])).closesNothing).toMatch(
      /not green on its head/,
    );
    expect((await judgeMergedPr(pr(2, 'no task here'), ['CI'])).closesNothing).toMatch(
      /names no task/,
    );
    expect((await judgeMergedPr(pr(3, 'Closes: T5'), ['CI'])).closesNothing).toMatch(/malformed/);
    const ok = await judgeMergedPr(pr(4, 'Closes: T5 AC1'), ['CI']);
    expect(ok.ciGreen).toBe(true);
    expect(ok.closesNothing).toBeUndefined();
    expect(formatMergeReceipt(ok)).toMatch(/close T5 \(AC1\)/);
  });
});

describe('sweep closes the tasks a merged PR names (T14101)', () => {
  it('green CI and every criterion mapped: records, completes and audits', async () => {
    const id = await seedTask(['first criterion', 'second criterion']);
    const { deps, calls } = fakeDeps([pr(10, `Closes: ${id} AC1,AC2`)]);
    const result = await sweepMergedClosures(root, { force: true }, deps);
    expect(result.swept).toBe(true);
    expect(result.closed).toEqual([id]);
    expect(calls.record).toEqual([
      { taskId: id, prNumber: 10, acs: ['AC1', 'AC2'], dryRun: false },
    ]);
    expect(calls.complete).toEqual([id]);
    // The sweep binds a session for its writes (none was bound here).
    expect(calls.sessionsAtComplete[0]).not.toBeNull();
    const rows = await mergeRows(id);
    expect(rows).toHaveLength(1);
    expect(JSON.parse(rows[0]?.detailsJson ?? '{}')).toMatchObject({
      prNumber: 10,
      acs: ['AC1', 'AC2'],
    });
    expect(existsSync(join(root, '.cleo', 'merge-sweep.json'))).toBe(true);
  });

  it('red CI closes nothing and comments why, once', async () => {
    const id = await seedTask(['only criterion']);
    const { deps, calls } = fakeDeps([pr(11, `Closes: ${id} AC1`, red)]);
    const first = await sweepMergedClosures(root, { force: true }, deps);
    expect(first.closed).toEqual([]);
    expect(first.refused[0]).toMatchObject({ taskId: id, prNumber: 11 });
    expect(first.refused[0]?.reason).toMatch(/not green/);
    expect(calls.record).toHaveLength(0);
    expect(calls.comments).toHaveLength(1);
    await sweepMergedClosures(root, { force: true }, deps);
    expect(calls.comments).toHaveLength(1);
  });

  it('a criterion no merged PR binds closes nothing', async () => {
    const id = await seedTask(['first criterion', 'second criterion']);
    const { deps, calls } = fakeDeps([pr(12, `Closes: ${id} AC1`)]);
    const result = await sweepMergedClosures(root, { force: true }, deps);
    expect(waitingOn(result)).toMatch(/no merged PR binds AC2/);
    expect(calls.record).toHaveLength(0);
    expect(calls.complete).toHaveLength(0);
  });

  it('a criterion the task does not have closes nothing', async () => {
    const id = await seedTask(['only criterion']);
    const { deps } = fakeDeps([pr(13, `Closes: ${id} AC1,AC4`)]);
    const result = await sweepMergedClosures(root, { force: true }, deps);
    expect(result.refused[0]?.reason).toMatch(/has no AC4/);
  });

  it('a PR that names no task closes nothing and is left to the CI comment', async () => {
    const { deps, calls } = fakeDeps([pr(14, 'just a refactor')]);
    const result = await sweepMergedClosures(root, { force: true }, deps);
    expect(result.prs[0]?.closesNothing).toMatch(/names no task/);
    expect(calls.comments).toHaveLength(0);
  });

  it('Refs: binds part of a task; a later Closes: completes it with the union', async () => {
    const id = await seedTask(['first criterion', 'second criterion']);
    const { deps, calls } = fakeDeps([
      pr(15, `Refs: ${id} AC1`, green, '2026-10-28T09:00:00Z'),
      pr(16, `Closes: ${id} AC2`, green, '2026-10-28T10:00:00Z'),
    ]);
    const result = await sweepMergedClosures(root, { force: true }, deps);
    expect(result.bound).toEqual([id]);
    expect(result.closed).toEqual([id]);
    expect(calls.record).toEqual([
      { taskId: id, prNumber: 16, acs: ['AC1', 'AC2'], dryRun: false },
    ]);
  });

  it('a rerun records nothing twice', async () => {
    const id = await seedTask(['only criterion']);
    const { deps, calls } = fakeDeps([pr(17, `Closes: ${id} AC1`)]);
    await sweepMergedClosures(root, { force: true }, deps);
    const again = await sweepMergedClosures(root, { force: true }, deps);
    expect(again.prs[0]?.outcomes[0]?.action).toBe('already');
    expect(calls.record).toHaveLength(1);
    expect(calls.complete).toHaveLength(1);
    expect(await mergeRows(id)).toHaveLength(1);
  });

  it('a dry run reports the closure and writes, completes and comments nothing', async () => {
    const id = await seedTask(['only criterion']);
    const { deps, calls } = fakeDeps([pr(18, `Closes: ${id} AC1`)]);
    const result = await sweepMergedClosures(root, { force: true, dryRun: true }, deps);
    expect(result.dryRun).toBe(true);
    expect(result.closed).toEqual([id]);
    expect(calls.record[0]?.dryRun).toBe(true);
    expect(calls.complete).toHaveLength(0);
    expect(await mergeRows(id)).toHaveLength(0);
    expect(existsSync(join(root, '.cleo', 'merge-sweep.json'))).toBe(false);
  });

  it('a dry run of an open PR checks its lines before merge; a real run refuses it', async () => {
    const id = await seedTask(['first criterion', 'second criterion']);
    const open = { ...pr(19, `Closes: ${id} AC1,AC2`, []), mergedAt: '' };
    const { deps, calls } = fakeDeps([open]);
    const dry = await sweepMergedClosures(root, { prNumbers: [19], dryRun: true }, deps);
    expect(dry.prs[0]?.outcomes[0]).toMatchObject({ action: 'closed', reason: /once it merges/ });
    expect(calls.record).toHaveLength(0);
    const unmapped = fakeDeps([{ ...open, body: `Closes: ${id} AC1` }]);
    const bad = await sweepMergedClosures(root, { prNumbers: [19], dryRun: true }, unmapped.deps);
    expect(waitingOn(bad)).toMatch(/no merged PR binds AC2/);
    const real = await sweepMergedClosures(root, { prNumbers: [19] }, deps);
    expect(real.prs[0]?.closesNothing).toMatch(/has not merged/);
    expect(calls.complete).toHaveLength(0);
  });

  it('a lazy sweep within 5 minutes of the last is throttled; force is not', async () => {
    const { deps } = fakeDeps([]);
    expect((await sweepMergedClosures(root, {}, deps)).swept).toBe(true);
    const state = JSON.parse(readFileSync(join(root, '.cleo', 'merge-sweep.json'), 'utf-8'));
    expect(typeof state.lastSweptAt).toBe('string');
    expect((await sweepMergedClosures(root, {}, deps)).skippedReason).toMatch(/throttled/);
    expect((await sweepMergedClosures(root, { force: true }, deps)).swept).toBe(true);
  });

  it('without gh it reports swept:false instead of throwing', async () => {
    const { deps } = fakeDeps([]);
    const result = await sweepMergedClosures(
      root,
      { force: true },
      { ...deps, ghAvailable: async () => false },
    );
    expect(result).toMatchObject({ swept: false, closed: [] });
    expect(result.skippedReason).toMatch(/gh/);
  });
});

describe('the lazy sweep is safe to start from read commands (T14101)', () => {
  it('concurrent claims start one sweep; a stale claim is taken again', () => {
    const claims = [claimMergeSweep(root), claimMergeSweep(root), claimMergeSweep(root)];
    expect(claims).toEqual([true, false, false]);
    const claim = join(root, '.cleo', 'merge-sweep.claim');
    const old = (Date.now() - MERGE_SWEEP_INTERVAL_MS - 1000) / 1000;
    utimesSync(claim, old, old);
    expect([claimMergeSweep(root), claimMergeSweep(root)]).toEqual([true, false]);
  });

  it('never spawns in CI, under vitest, when off, or without gh credentials', () => {
    const home = mkdtempSync(join(tmpdir(), 'cleo-merge-sweep-home-'));
    expect(mergeSweepSpawnAllowed({ CI: 'true', GH_TOKEN: 'x' }, home)).toBe(false);
    expect(mergeSweepSpawnAllowed({ VITEST: 'true', GH_TOKEN: 'x' }, home)).toBe(false);
    expect(mergeSweepSpawnAllowed({ CLEO_MERGE_SWEEP: 'off', GH_TOKEN: 'x' }, home)).toBe(false);
    expect(mergeSweepSpawnAllowed({}, home)).toBe(false);
    expect(mergeSweepSpawnAllowed({ GH_TOKEN: 'x' }, home)).toBe(true);
    mkdirSync(join(home, '.config', 'gh'), { recursive: true });
    writeFileSync(join(home, '.config', 'gh', 'hosts.yml'), 'github.com: {}\n');
    expect(mergeSweepSpawnAllowed({}, home)).toBe(true);
  });

  it('its state and claim files are never committed', () => {
    const repo = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..', '..');
    for (const file of ['.cleo/merge-sweep.json', '.cleo/merge-sweep.claim']) {
      // Exit 0 means ignored; a tracked or unignored path throws.
      expect(() => execFileSync('git', ['check-ignore', '-q', file], { cwd: repo })).not.toThrow();
    }
  });
});

describe('one sweep also runs the upkeep hooks (T14101)', () => {
  it('turns a macos-regression issue into one task under the configured parent, and closes it when done', async () => {
    const parent = (
      await addTask(
        {
          title: 'macOS regressions',
          description: 'epic for macOS regression tasks',
          type: 'epic',
          skipContainmentInvariant: true,
        },
        root,
        env.accessor,
      )
    ).task.id;
    writeFileSync(
      join(root, '.cleo', 'project-context.json'),
      JSON.stringify({ release: { macosRegressionParent: parent } }),
    );
    const issue = { url: 'https://github.com/o/r/issues/7', title: 'shard 3 fails on macOS' };
    const { deps, calls } = fakeDeps([], [issue]);
    const first = await sweepMergedClosures(root, { force: true }, deps);
    const created = first.hooks?.macosRegression?.created ?? [];
    expect(created).toHaveLength(1);
    const task = await env.accessor.loadSingleTask(created[0] ?? '');
    expect(task?.title).toBe('macOS regression: shard 3 fails on macOS');
    expect(task?.parentId).toBe(parent);
    const again = await sweepMergedClosures(root, { force: true }, deps);
    expect(again.hooks?.macosRegression?.created).toEqual([]);
    await env.accessor.updateTaskFields(created[0] ?? '', {
      status: 'done',
      pipelineStage: 'contribution',
    });
    const closing = await sweepMergedClosures(root, { force: true }, deps);
    expect(closing.hooks?.macosRegression?.closedIssues).toEqual([issue.url]);
    expect(calls.closedIssues).toEqual([issue.url]);
  });

  it('without a configured parent it reads no issues', async () => {
    const { deps } = fakeDeps([], [{ url: 'https://github.com/o/r/issues/9', title: 'x' }]);
    const result = await sweepMergedClosures(root, { force: true }, deps);
    expect(result.hooks?.macosRegression).toMatchObject({ created: [] });
    expect(result.hooks?.macosRegression?.skippedReason).toMatch(/macosRegressionParent/);
  });

  it('a dry run creates no issue task and runs no reconcile', async () => {
    let reconciled = 0;
    const epic = await addTask(
      {
        title: 'macOS regressions',
        description: 'epic',
        type: 'epic',
        skipContainmentInvariant: true,
      },
      root,
      env.accessor,
    );
    writeFileSync(
      join(root, '.cleo', 'project-context.json'),
      JSON.stringify({ release: { macosRegressionParent: epic.task.id } }),
    );
    const { deps } = fakeDeps([], [{ url: 'https://github.com/o/r/issues/8', title: 'x' }]);
    const result = await sweepMergedClosures(
      root,
      { force: true, dryRun: true },
      {
        ...deps,
        reconcile: async () => {
          reconciled++;
          return { version: 'v1', action: 'reconciled' };
        },
      },
    );
    expect(result.hooks?.macosRegression?.created).toEqual(['https://github.com/o/r/issues/8']);
    expect(result.hooks?.reconcile).toBeUndefined();
    expect(reconciled).toBe(0);
  });

  it('flags stale docs once, on the run that applied the PR, and reconciles the newest release', async () => {
    const id = await seedTask(['only criterion']);
    const flaggedFor: string[][] = [];
    const { deps } = fakeDeps([pr(20, `Closes: ${id} AC1`)]);
    const hooked: MergeCloseDeps = {
      ...deps,
      docsRot: async (_root, change) => {
        // flagDocsRotOnTasks writes through updateTask, which needs a bound session.
        expect(await getActiveSessionInfo(root)).not.toBeNull();
        flaggedFor.push(change.taskIds);
        return change.taskIds;
      },
      reconcile: async () => ({ version: 'v2026.10.27', action: 'already' }),
    };
    const first = await sweepMergedClosures(root, { force: true }, hooked);
    expect(first.hooks?.docsRot).toEqual([id]);
    expect(first.hooks?.reconcile).toEqual({ version: 'v2026.10.27', action: 'already' });
    await sweepMergedClosures(root, { force: true }, hooked);
    expect(flaggedFor).toEqual([[id]]);
  });

  it('cleans up after the applied tasks only when opted in (T14142)', async () => {
    const cleanedFor: string[][] = [];
    const sweep = async (prNumber: number, enabled: boolean) => {
      const id = await seedTask(['only criterion']);
      const { deps } = fakeDeps([pr(prNumber, `Closes: ${id} AC1`)]);
      const result = await sweepMergedClosures(
        root,
        { force: true },
        {
          ...deps,
          canCleanup: () => enabled,
          cleanupMerged: async (_root, taskIds) => {
            cleanedFor.push(taskIds);
            return {
              dryRun: false,
              base: 'origin/main',
              worktrees: [],
              localBranches: [],
              remoteBranches: [],
              nestedCopies: [],
              bytesReclaimed: 0,
            };
          },
        },
      );
      return { id, result };
    };
    const off = await sweep(21, false);
    expect(off.result.hooks?.cleanup).toBeUndefined();
    expect(cleanedFor).toEqual([]);
    const on = await sweep(22, true);
    expect(on.result.hooks?.cleanup).toHaveLength(1);
    expect(cleanedFor).toEqual([[on.id]]);
  });
});

describe('a sweep never skips merged PRs past one page (T14101, council review)', () => {
  /** `count` merged PRs, a minute apart, newest last; PR 1000+i names task `taskOf(i)` when given. */
  function many(count: number, body: (i: number) => string = () => 'no task'): MergedPrRecord[] {
    return Array.from({ length: count }, (_, i) =>
      pr(1000 + i, body(i), green, new Date(Date.UTC(2026, 9, 28, 0, i)).toISOString()),
    );
  }

  /** gh's behaviour: the window's newest page first, at most one page per call. */
  function windowed(all: MergedPrRecord[]): MergeCloseDeps['listMergedPrs'] {
    return async (_root, since, until) =>
      all
        .filter((p) => p.mergedAt >= since && (until === undefined || p.mergedAt <= until))
        .sort((a, b) => b.mergedAt.localeCompare(a.mergedAt))
        // gh's page: a fixed 50 rows, whatever the sweep's own constant says.
        .slice(0, 50);
  }

  it('council red test (T14121): a 50-row page over 60 merged PRs never drops the PR carrying Closes:', async () => {
    const id = await seedTask(['only criterion']);
    // gh returns the newest 50; PR #1003 is older than every returned PR.
    const all = many(60, (i) => (i === 3 ? `Closes: ${id} AC1` : 'no task'));
    const { deps } = fakeDeps(all);
    const sweep = { ...deps, listMergedPrs: windowed(all) };
    const since = '2026-10-27T00:00:00.000Z';
    const first = await sweepMergedClosures(root, { force: true, since }, sweep);
    const second = await sweepMergedClosures(root, { force: true }, sweep);
    expect([...first.closed, ...second.closed]).toEqual([id]);
  });

  it('pages through more than 50 PRs merged between sweeps and closes every task', async () => {
    const ids = [await seedTask(['a']), await seedTask(['b', 'c'])];
    // The two task PRs are the OLDEST of 120, below the first page.
    const lines = [`Closes: ${ids[0]} AC1`, `Closes: ${ids[1]} AC1,AC2`];
    const all = many(120, (i) => lines[i] ?? 'no task');
    const { deps } = fakeDeps(all);
    const result = await sweepMergedClosures(
      root,
      { force: true, since: '2026-10-27T00:00:00.000Z' },
      { ...deps, listMergedPrs: windowed(all) },
    );
    expect(result.prs).toHaveLength(120);
    expect(result.closed.sort()).toEqual([...ids].sort());
    expect(result.truncated).toBeUndefined();
  });

  it('past the page budget it reports truncated and reads the rest first next time', async () => {
    const total = MERGE_SWEEP_PR_LIMIT * MERGE_SWEEP_MAX_PAGES + 20;
    const id = await seedTask(['only criterion']);
    const all = many(total, (i) => (i === 0 ? `Closes: ${id} AC1` : 'no task'));
    const { deps } = fakeDeps(all);
    const sweep = { ...deps, listMergedPrs: windowed(all) };
    const first = await sweepMergedClosures(root, { force: true }, sweep);
    // Each page after the first repeats its boundary PR (the window is inclusive).
    expect(first.truncated?.read).toBeGreaterThan(
      MERGE_SWEEP_PR_LIMIT * (MERGE_SWEEP_MAX_PAGES - 1),
    );
    expect(first.truncated?.read).toBeLessThan(total);
    expect(first.closed).toEqual([]);
    const second = await sweepMergedClosures(root, { force: true }, sweep);
    expect(second.closed).toEqual([id]);
    expect(second.truncated).toBeUndefined();
  });
});

describe('satisfies comes only from an independent verdict on the merged head (T14122, D11211)', () => {
  it('a missing, unmet or stale verdict closes nothing and says which criterion', async () => {
    const id = await seedTask(['first criterion', 'second criterion']);
    const merged = pr(30, `Closes: ${id} AC1,AC2`);
    const head = merged.headRefOid ?? '';
    const cases: Array<[ReviewVerdict[], RegExp]> = [
      [[], /AC1: no verdict on head \w+; AC2: no verdict on head \w+/],
      [
        [verdict(id, 30, 'AC1', head, 'met'), verdict(id, 30, 'AC2', head, 'unmet')],
        /AC2: reviewed unmet on head/,
      ],
      [
        [verdict(id, 30, 'AC1', head, 'met'), verdict(id, 30, 'AC2', 'f'.repeat(40), 'met')],
        /AC2: no verdict on head \w+ \(latest is for fffffff\)/,
      ],
    ];
    for (const [verdicts, reason] of cases) {
      const { deps, calls } = fakeDeps([merged]);
      const result = await sweepMergedClosures(
        root,
        { force: true },
        { ...deps, reviewVerdicts: async () => verdicts },
      );
      expect(result.closed).toEqual([]);
      expect(waitingOn(result)).toMatch(reason);
      expect(calls.record).toHaveLength(0);
    }
  });

  it("a verdict by the task's own author does not count", async () => {
    const id = await seedTask(['only criterion']);
    const merged = pr(34, `Closes: ${id} AC1`);
    const own = {
      ...verdict(id, 34, 'AC1', merged.headRefOid ?? '', 'met'),
      reviewer: { sessionId: 'ses_author', agentId: null },
    };
    const { deps } = fakeDeps([merged]);
    const result = await sweepMergedClosures(
      root,
      { force: true },
      { ...deps, reviewVerdicts: async () => [own] },
    );
    expect(result.closed).toEqual([]);
    expect(waitingOn(result)).toMatch(/AC1: reviewed by the task's own author/);
  });

  it('a later met verdict that answers the earlier unmet one closes (T14128)', async () => {
    const id = await seedTask(['only criterion']);
    const merged = pr(31, `Closes: ${id} AC1`);
    const head = merged.headRefOid ?? '';
    const unmet = verdict(id, 31, 'AC1', head, 'unmet', '2026-10-28T08:00:00Z');
    const answering = {
      ...verdict(id, 31, 'AC1', head, 'met', '2026-10-28T09:00:00Z'),
      answers: unmet.id,
    };
    const { deps } = fakeDeps([merged]);
    const result = await sweepMergedClosures(
      root,
      { force: true },
      { ...deps, reviewVerdicts: async () => [unmet, answering] },
    );
    expect(result.closed).toEqual([id]);
  });

  it('a later met that does not answer the unmet one closes nothing (review shopping, T14128)', async () => {
    const id = await seedTask(['only criterion']);
    const merged = pr(35, `Closes: ${id} AC1`);
    const head = merged.headRefOid ?? '';
    const verdicts = [
      verdict(id, 35, 'AC1', head, 'unmet', '2026-10-28T08:00:00Z'),
      verdict(id, 35, 'AC1', head, 'met', '2026-10-28T09:00:00Z'),
    ];
    const { deps, calls } = fakeDeps([merged]);
    const result = await sweepMergedClosures(
      root,
      { force: true },
      { ...deps, reviewVerdicts: async () => verdicts },
    );
    expect(result.closed).toEqual([]);
    expect(waitingOn(result)).toMatch(/does not answer unmet verdict/);
    expect(calls.record).toHaveLength(0);
  });

  it('without the review module nothing closes', async () => {
    const id = await seedTask(['only criterion']);
    const { deps } = fakeDeps([pr(32, `Closes: ${id} AC1`)]);
    const { reviewVerdicts: _unset, ...withoutReview } = deps;
    const result = await sweepMergedClosures(root, { force: true }, withoutReview);
    expect(result.closed).toEqual([]);
    expect(waitingOn(result)).toMatch(/AC1: no verdict on head/);
  });

  it('checks open PRs before merge: a red status names the gap, green once verified, posted once each', async () => {
    const id = await seedTask(['first criterion', 'second criterion']);
    const open = { ...pr(33, `Closes: ${id} AC1,AC2`, []), mergedAt: '' };
    const head = open.headRefOid ?? '';
    let verdicts: ReviewVerdict[] = [verdict(id, 33, 'AC1', head, 'met')];
    const { deps, calls } = fakeDeps([], [], [open]);
    const sweep = { ...deps, reviewVerdicts: async () => verdicts };
    const first = await sweepMergedClosures(root, { force: true }, sweep);
    expect(first.openChecks?.[0]).toMatchObject({ prNumber: 33, state: 'failure' });
    expect(calls.statuses[0]?.description).toMatch(/AC2: no verdict on head/);
    await sweepMergedClosures(root, { force: true }, sweep);
    expect(calls.statuses).toHaveLength(1);
    verdicts = [...verdicts, verdict(id, 33, 'AC2', head, 'met')];
    await sweepMergedClosures(root, { force: true }, sweep);
    expect(calls.statuses.map((c) => c.state)).toEqual(['failure', 'success']);
  });
});

describe('a merge whose own CI run was cancelled waits, and is rerun once (T14101)', () => {
  const ciRefusal = "Required CI on PR #40's merge commit is not green: CI: cancelled";

  it('waits, reruns the cancelled run once, and closes once a run is green', async () => {
    const id = await seedTask(['only criterion']);
    const { deps, calls, world } = fakeDeps([pr(40, `Closes: ${id} AC1`)]);
    world.recordRefusal = ciRefusal;
    world.mergeRun = { runId: 77, status: 'completed', conclusion: 'cancelled' };
    const first = await sweepMergedClosures(root, { force: true }, deps);
    expect(first.prs[0]?.outcomes[0]).toMatchObject({ action: 'waiting', reason: /reran run 77/ });
    expect([first.waiting, first.reran]).toEqual([1, 1]);
    expect(calls.comments).toHaveLength(0);
    // The PR is past the cursor, but the waiting list brings it back.
    const state = JSON.parse(readFileSync(join(root, '.cleo', 'merge-sweep.json'), 'utf-8'));
    expect(Object.keys(state.waiting)).toEqual(['40']);
    // gh lists nothing new: only the waiting list can bring PR #40 back.
    const laterSweeps = { ...deps, listMergedPrs: async () => [] };
    world.mergeRun = { runId: 78, status: 'in_progress', conclusion: null };
    world.now += HOUR * 7; // past any backoff
    const second = await sweepMergedClosures(root, { force: true }, laterSweeps);
    expect(second.prs[0]?.outcomes[0]?.action).toBe('waiting');
    // A wait on the merge's own CI resolves itself: never commented.
    expect(calls.comments).toHaveLength(0);
    world.recordRefusal = null;
    world.now += HOUR * 7;
    const third = await sweepMergedClosures(root, { force: true }, laterSweeps);
    expect(third.closed).toEqual([id]);
    expect(calls.reruns).toEqual([77]);
    const after = JSON.parse(readFileSync(join(root, '.cleo', 'merge-sweep.json'), 'utf-8'));
    expect(after.waiting).toEqual({});
  });

  it('reruns a merge commit at most once, ever', async () => {
    const id = await seedTask(['only criterion']);
    const { deps, calls, world } = fakeDeps([pr(41, `Closes: ${id} AC1`)]);
    world.recordRefusal = ciRefusal;
    world.mergeRun = { runId: 80, status: 'completed', conclusion: 'cancelled' };
    await sweepMergedClosures(root, { force: true }, deps);
    world.mergeRun = { runId: 81, status: 'completed', conclusion: 'cancelled' };
    const again = await sweepMergedClosures(root, { force: true }, deps);
    expect(again.prs[0]?.outcomes[0]?.reason).toMatch(/one rerun is done/);
    expect(again.reran).toBe(0);
    expect(calls.reruns).toEqual([80]);
  });

  it('a failed merge run is never rerun: the refusal is real and is commented', async () => {
    const id = await seedTask(['only criterion']);
    const { deps, calls, world } = fakeDeps([pr(42, `Closes: ${id} AC1`)]);
    world.recordRefusal = "Required CI on PR #42's merge commit is not green: CI: failure";
    world.mergeRun = { runId: 90, status: 'completed', conclusion: 'failure' };
    const result = await sweepMergedClosures(root, { force: true }, deps);
    expect(result.refused[0]?.reason).toMatch(/CI: failure/);
    expect([result.waiting, result.reran]).toEqual([0, 0]);
    expect(calls.reruns).toEqual([]);
    expect(calls.comments).toHaveLength(1);
  });

  it("reruns are off by default until T14136 (rerun joins main's push concurrency group)", () => {
    const prior = { flag: process.env['CLEO_MERGE_SWEEP_RERUN'], ci: process.env['CI'] };
    delete process.env['CLEO_MERGE_SWEEP_RERUN'];
    delete process.env['CI'];
    try {
      expect(defaultMergeCloseDeps.canRerun()).toBe(false);
      process.env['CLEO_MERGE_SWEEP_RERUN'] = '1';
      expect(defaultMergeCloseDeps.canRerun()).toBe(true);
      process.env['CI'] = 'true';
      expect(defaultMergeCloseDeps.canRerun()).toBe(false);
    } finally {
      if (prior.flag === undefined) delete process.env['CLEO_MERGE_SWEEP_RERUN'];
      else process.env['CLEO_MERGE_SWEEP_RERUN'] = prior.flag;
      if (prior.ci === undefined) delete process.env['CI'];
      else process.env['CI'] = prior.ci;
    }
  });

  it('where it may not rerun, the PR waits and is reported', async () => {
    const id = await seedTask(['only criterion']);
    const { deps, calls, world } = fakeDeps([pr(43, `Closes: ${id} AC1`)]);
    world.recordRefusal = ciRefusal;
    world.mergeRun = { runId: 95, status: 'completed', conclusion: 'skipped' };
    world.canRerun = false;
    const result = await sweepMergedClosures(root, { force: true }, deps);
    expect(result.prs[0]?.outcomes[0]).toMatchObject({
      action: 'waiting',
      reason: /automatic reruns are off until T14136/,
    });
    expect([result.waiting, result.reran]).toEqual([1, 0]);
    expect(calls.reruns).toEqual([]);
  });
});

describe('review fixes (#2555 review at a36298391)', () => {
  it('the daemon sweeps registered main checkouts only: never $HOME, a moved path or a worktree', async () => {
    const home = mkdtempSync(join(tmpdir(), 'cleo-merge-home-'));
    mkdirSync(join(home, '.cleo'), { recursive: true });
    const project = mkdtempSync(join(tmpdir(), 'cleo-merge-project-'));
    mkdirSync(join(project, '.git'), { recursive: true });
    mkdirSync(join(project, '.cleo'), { recursive: true });
    writeFileSync(
      join(project, '.cleo', 'project-context.json'),
      JSON.stringify({ evidence: { ciSatisfies: true } }),
    );
    // A linked worktree registered as a project: `.git` is a gitlink file.
    const worktree = mkdtempSync(join(tmpdir(), 'cleo-merge-worktree-'));
    writeFileSync(join(worktree, '.git'), `gitdir: ${join(project, '.git', 'worktrees', 'x')}\n`);
    mkdirSync(join(worktree, '.cleo'), { recursive: true });
    writeFileSync(
      join(worktree, '.cleo', 'project-context.json'),
      JSON.stringify({ evidence: { ciSatisfies: true } }),
    );
    const moved = join(tmpdir(), `cleo-merge-moved-${process.pid}-gone`);
    const swept: string[] = [];
    const run = (env: NodeJS.ProcessEnv) =>
      sweepRegisteredProjects({
        env,
        listRoots: async () => [home, moved, worktree, project],
        sweep: async (r) => {
          swept.push(r);
        },
      });
    expect(await run({ GH_TOKEN: 'x' })).toEqual([project]);
    expect(swept).toEqual([project]);
    expect(await run({ GH_TOKEN: 'x', CI: 'true' })).toEqual([]);
    expect(await run({})).toEqual([]);
  });

  it('a waiting PR gh cannot view stays on the waiting list', async () => {
    const id = await seedTask(['only criterion']);
    const merged = pr(50, `Closes: ${id} AC1`);
    const { deps, world } = fakeDeps([merged]);
    await sweepMergedClosures(root, { force: true }, { ...deps, reviewVerdicts: async () => [] });
    const before = JSON.parse(readFileSync(join(root, '.cleo', 'merge-sweep.json'), 'utf-8'));
    expect(Object.keys(before.waiting)).toEqual(['50']);
    world.now += HOUR * 7;
    await sweepMergedClosures(
      root,
      { force: true },
      { ...deps, listMergedPrs: async () => [], viewPr: async () => null },
    );
    const after = JSON.parse(readFileSync(join(root, '.cleo', 'merge-sweep.json'), 'utf-8'));
    expect(Object.keys(after.waiting)).toEqual(['50']);
  });

  it('transient failures wait and are re-judged; a later verdict closes the task', async () => {
    const id = await seedTask(['only criterion']);
    const merged = pr(51, `Closes: ${id} AC1`);
    const { deps, calls, world } = fakeDeps([merged]);
    const throwing = {
      ...deps,
      reviewVerdicts: async (): Promise<ReviewVerdict[]> => {
        throw new Error('gh: API rate limit exceeded');
      },
    };
    const first = await sweepMergedClosures(root, { force: true }, throwing);
    expect(first.refused).toEqual([]);
    expect(waitingOn(first)).toMatch(/rate limit/);
    world.now += HOUR * 7;
    const noVerdict = await sweepMergedClosures(
      root,
      { force: true },
      { ...deps, reviewVerdicts: async () => [] },
    );
    expect(waitingOn(noVerdict)).toMatch(/no verdict on head/);
    // A gap wait is commented once per (PR, merge, task, kind), whatever the reason.
    expect(calls.comments).toHaveLength(1);
    expect(calls.comments[0]?.body).toMatch(/is waiting to close from this PR/);
    world.now += HOUR * 7;
    const later = await sweepMergedClosures(root, { force: true }, deps);
    expect(later.closed).toEqual([id]);
  });

  it('one sweep at a time: a held lock skips the second; a failed complete on a done task is already', async () => {
    const release = acquireMergeSweepLock(root);
    expect(release).not.toBeNull();
    expect(acquireMergeSweepLock(root)).toBeNull();
    const { deps } = fakeDeps([]);
    const blocked = await sweepMergedClosures(root, { force: true }, deps);
    expect(blocked.skippedReason).toMatch(/another merge sweep is running/);
    release?.();
    const again = acquireMergeSweepLock(root);
    expect(again).not.toBeNull();
    again?.();

    const id = await seedTask(['only criterion']);
    const raced = fakeDeps([pr(52, `Closes: ${id} AC1`)]);
    const result = await sweepMergedClosures(
      root,
      { force: true },
      {
        ...raced.deps,
        complete: async (_root, taskId) => {
          // Another sweep completed it between our record and our complete.
          await env.accessor.updateTaskFields(taskId, {
            status: 'done',
            pipelineStage: 'contribution',
          });
          return { ok: false, reason: 'task is already done' };
        },
      },
    );
    expect(result.prs[0]?.outcomes[0]?.action).toBe('already');
    expect(raced.calls.comments).toHaveLength(0);
  });

  it('a PR search indexes late (merged before the cursor) is still read, inside the overlap', async () => {
    const id = await seedTask(['only criterion']);
    const early = { ...pr(53, 'no task'), mergedAt: '2026-10-28T10:00:00.000Z' };
    const late = { ...pr(54, `Closes: ${id} AC1`), mergedAt: '2026-10-28T09:55:00.000Z' };
    const visible: MergedPrRecord[] = [early];
    const { deps } = fakeDeps([early, late]);
    const listing: MergeCloseDeps['listMergedPrs'] = async (_root, since, until) =>
      visible.filter((p) => p.mergedAt >= since && (until === undefined || p.mergedAt <= until));
    await sweepMergedClosures(
      root,
      { force: true, since: '2026-10-28T00:00:00.000Z' },
      { ...deps, listMergedPrs: listing },
    );
    visible.push(late);
    const second = await sweepMergedClosures(
      root,
      { force: true },
      { ...deps, listMergedPrs: listing },
    );
    expect(second.closed).toEqual([id]);
  });

  it('a backlog of more than two budgets drains, oldest window first', async () => {
    const total = MERGE_SWEEP_PR_LIMIT * MERGE_SWEEP_MAX_PAGES * 2 + 30;
    const id = await seedTask(['only criterion']);
    const all = Array.from({ length: total }, (_, i) =>
      pr(
        5000 + i,
        i === 0 ? `Closes: ${id} AC1` : 'no task',
        green,
        new Date(Date.UTC(2026, 9, 27, 0, i)).toISOString(),
      ),
    );
    const listing: MergeCloseDeps['listMergedPrs'] = async (_root, since, until) =>
      all
        .filter((p) => p.mergedAt >= since && (until === undefined || p.mergedAt <= until))
        .sort((a, b) => b.mergedAt.localeCompare(a.mergedAt))
        .slice(0, 50);
    const { deps } = fakeDeps(all);
    const sweep = { ...deps, listMergedPrs: listing };
    let closed: string[] = [];
    let sweeps = 0;
    let truncated = true;
    while (truncated && sweeps < 8) {
      const r = await sweepMergedClosures(
        root,
        sweeps === 0 ? { force: true, since: '2026-10-26T00:00:00.000Z' } : { force: true },
        sweep,
      );
      closed = [...closed, ...r.closed];
      truncated = r.truncated !== undefined;
      sweeps++;
    }
    expect(truncated).toBe(false);
    expect(closed).toEqual([id]);
  });
});

describe('re-review fixes (#2555 at d95a2597c)', () => {
  const lockPath = (): string => join(root, '.cleo', 'merge-sweep.lock');

  it('a stale lock is stolen; a fresh one is not', () => {
    writeFileSync(lockPath(), 'old-token');
    const old = (Date.now() - MERGE_SWEEP_LOCK_STALE_MS - 60_000) / 1000;
    utimesSync(lockPath(), old, old);
    const release = acquireMergeSweepLock(root);
    expect(release).not.toBeNull();
    expect(readFileSync(lockPath(), 'utf-8')).not.toBe('old-token');
    expect(acquireMergeSweepLock(root)).toBeNull();
    release?.();
  });

  it('of two stealers that judged the same stale lock, only one wins', () => {
    writeFileSync(lockPath(), 'old-token');
    const old = (Date.now() - MERGE_SWEEP_LOCK_STALE_MS - 60_000) / 1000;
    utimesSync(lockPath(), old, old);
    // B steals first and holds a fresh lock.
    const b = acquireMergeSweepLock(root);
    expect(b).not.toBeNull();
    const fresh = readFileSync(lockPath(), 'utf-8');
    // A judged the same stale token earlier; its steal must not take B's lock.
    expect(stealStaleLock(lockPath(), 'old-token')).toBe(false);
    expect(readFileSync(lockPath(), 'utf-8')).toBe(fresh);
    b?.();
  });

  it('a PR waiting on verdicts backs off without gh calls, and is re-judged at once when a verdict lands', async () => {
    const id = await seedTask(['only criterion']);
    const merged = pr(60, `Closes: ${id} AC1`);
    const { deps, world } = fakeDeps([merged]);
    let verdicts: ReviewVerdict[] = [];
    let views = 0;
    const sweep: MergeCloseDeps = {
      ...deps,
      reviewVerdicts: async () => verdicts,
      viewPr: async (r, n) => {
        views++;
        return deps.viewPr(r, n);
      },
    };
    await sweepMergedClosures(root, { force: true }, sweep);
    const later = { ...sweep, listMergedPrs: async () => [] };
    // Not due: nothing re-judged.
    await sweepMergedClosures(root, { force: true }, later);
    // Due, but waiting only on unchanged verdicts: judged locally, no gh view.
    world.now += HOUR * 7;
    await sweepMergedClosures(root, { force: true }, later);
    expect(views).toBe(0);
    const state = JSON.parse(readFileSync(join(root, '.cleo', 'merge-sweep.json'), 'utf-8'));
    expect(state.waiting['60'].intervalMs).toBeGreaterThan(5 * 60_000);
    // A verdict lands: re-judged at once, before the backoff runs out.
    verdicts = [verdict(id, 60, 'AC1', merged.headRefOid ?? '', 'met')];
    const closing = await sweepMergedClosures(root, { force: true }, later);
    expect(views).toBe(1);
    expect(closing.closed).toEqual([id]);
  });

  it('a PR still waiting after 14 days is refused once, with a final comment', async () => {
    const id = await seedTask(['only criterion']);
    const merged = pr(61, `Closes: ${id} AC1`);
    const { deps, world, calls } = fakeDeps([merged]);
    const sweep = { ...deps, reviewVerdicts: async () => [] };
    await sweepMergedClosures(root, { force: true }, sweep);
    expect(calls.comments).toHaveLength(1);
    world.now += MERGE_WAITING_MAX_AGE_MS + HOUR;
    const aged = await sweepMergedClosures(
      root,
      { force: true },
      { ...sweep, listMergedPrs: async () => [] },
    );
    expect(aged.refused).toEqual([
      { taskId: id, prNumber: 61, reason: 'waited 14 days without a reviewer verdict' },
    ]);
    expect(calls.comments).toHaveLength(2);
    const state = JSON.parse(readFileSync(join(root, '.cleo', 'merge-sweep.json'), 'utf-8'));
    expect(state.waiting).toEqual({});
    // T14139: a third sweep posts nothing more.
    world.now += HOUR * 7;
    await sweepMergedClosures(root, { force: true }, { ...sweep, listMergedPrs: async () => [] });
    expect(calls.comments).toHaveLength(2);
  });

  it('age-out skips a task already done by another route: no refusal, no comment (T14139)', async () => {
    const id = await seedTask(['only criterion']);
    const merged = pr(65, `Closes: ${id} AC1`);
    const { deps, world, calls } = fakeDeps([merged]);
    const sweep = { ...deps, reviewVerdicts: async () => [] };
    await sweepMergedClosures(root, { force: true }, sweep);
    expect(calls.comments).toHaveLength(1);
    await env.accessor.updateTaskFields(id, { status: 'done', pipelineStage: 'contribution' });
    world.now += MERGE_WAITING_MAX_AGE_MS + HOUR;
    const aged = await sweepMergedClosures(
      root,
      { force: true },
      { ...sweep, listMergedPrs: async () => [] },
    );
    expect(aged.refused).toEqual([]);
    expect(aged.prs[0]?.outcomes[0]?.action).toBe('already');
    expect(calls.comments).toHaveLength(1);
  });

  it('the lock is taken only while the path holds our own token (T14139)', () => {
    const release = acquireMergeSweepLock(root);
    expect(release).not.toBeNull();
    const token = readFileSync(lockPath(), 'utf-8');
    expect(lockHolds(lockPath(), token)).toBe(true);
    // A third party swaps the lock: our token no longer holds, and release leaves theirs.
    writeFileSync(lockPath(), 'someone-else');
    expect(lockHolds(lockPath(), token)).toBe(false);
    release?.();
    expect(readFileSync(lockPath(), 'utf-8')).toBe('someone-else');
  });

  it('a sweep past its run cap carries the rest on the waiting list', async () => {
    const ids = [await seedTask(['a']), await seedTask(['b', 'c'])];
    const prs = [
      { ...pr(62, `Closes: ${ids[0]} AC1`), mergedAt: '2026-10-28T09:00:00Z' },
      { ...pr(63, `Closes: ${ids[1]} AC1,AC2`), mergedAt: '2026-10-28T10:00:00Z' },
    ];
    const { deps, world } = fakeDeps(prs);
    const slow: MergeCloseDeps = {
      ...deps,
      complete: async (r, taskId, n) => {
        const done = await deps.complete(r, taskId, n);
        world.now += 100_000; // the first PR used up the 90 s cap
        return done;
      },
    };
    const result = await sweepMergedClosures(root, { force: true }, slow);
    expect(result.closed).toEqual([ids[0]]);
    const state = JSON.parse(readFileSync(join(root, '.cleo', 'merge-sweep.json'), 'utf-8'));
    expect(Object.keys(state.waiting)).toEqual(['63']);
    const next = await sweepMergedClosures(
      root,
      { force: true },
      { ...slow, listMergedPrs: async () => [] },
    );
    expect(next.closed).toEqual([ids[1]]);
  });

  it('an empty read keeps the high-water mark (never the local clock)', async () => {
    const { deps } = fakeDeps([{ ...pr(64, 'no task'), mergedAt: '2026-10-28T10:00:00.000Z' }]);
    await sweepMergedClosures(root, { force: true, since: '2026-10-28T00:00:00.000Z' }, deps);
    await sweepMergedClosures(root, { force: true }, { ...deps, listMergedPrs: async () => [] });
    const state = JSON.parse(readFileSync(join(root, '.cleo', 'merge-sweep.json'), 'utf-8'));
    expect(state.highWater).toBe('2026-10-28T10:00:00.000Z');
  });
});
