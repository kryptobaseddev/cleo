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

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { GhPrViewPayload } from '@cleocode/contracts';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createTestDb, type TestDbEnv } from '../../store/__tests__/test-db-helper.js';
import { resetDbState } from '../../store/sqlite.js';
import { addTask } from '../add.js';
import {
  formatMergeReceipt,
  judgeMergedPr,
  MERGE_CLOSE_AUDIT_ACTION,
  type MergeCloseDeps,
  type MergedPrRecord,
  parseMergeDirectives,
  sweepMergedClosures,
} from '../merge-close.js';

let env: TestDbEnv;
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
      acceptance,
      skipContainmentInvariant: true,
    },
    root,
    env.accessor,
  );
  return result.task.id;
}

/** Fake outside world: the PRs gh lists, and a record of every call. */
function fakeDeps(prs: MergedPrRecord[]) {
  const calls = {
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
      return { ok: true };
    },
    complete: async (_root, taskId) => {
      calls.complete.push(taskId);
      await env.accessor.updateTaskFields(taskId, {
        status: 'done',
        pipelineStage: 'contribution',
      });
      return { ok: true };
    },
  };
  return { deps, calls };
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
    expect(result.refused[0]?.reason).toMatch(/no merged PR binds AC2/);
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
    expect(bad.refused[0]?.reason).toMatch(/no merged PR binds AC2/);
    const real = await sweepMergedClosures(root, { prNumbers: [19] }, deps);
    expect(real.prs[0]?.closesNothing).toMatch(/has not merged/);
    expect(calls.complete).toHaveLength(0);
  });

  it('a lazy sweep within 5 minutes of the last is throttled; force is not', async () => {
    const { deps } = fakeDeps([]);
    await sweepMergedClosures(root, { force: true }, deps);
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
