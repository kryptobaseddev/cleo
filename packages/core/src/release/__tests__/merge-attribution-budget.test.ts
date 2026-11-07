/**
 * The fix task a budget crossing files (T14254, D11225): one open
 * `main-over-budget` task per budget, under the epic of the crossing PR's
 * task, naming the PR; a second crossing of the same budget files none.
 *
 * @task T14254
 */

import type { MergeAttributionReceipt } from '@cleocode/contracts';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createTestDb, type TestDbEnv } from '../../store/__tests__/test-db-helper.js';
import { resetDbState } from '../../store/sqlite.js';
import { addTask } from '../../tasks/add.js';
import { fileMainBudgetTasks, MAIN_OVER_BUDGET_LABEL } from '../merge-attribution.js';

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

/** A receipt whose build job crossed the core bundle budget. */
function crossed(prNumber: number): MergeAttributionReceipt {
  return {
    prNumber,
    headSha: 'head',
    mergeSha: `merge${prNumber}`,
    resolvedFrom: 'merge-commit',
    parentSha: 'parent',
    mergeRuns: [],
    parentRuns: [],
    failures: [
      {
        job: 'Build & Verify (ubuntu-latest)',
        tests: [],
        cause: 'step:node packages/core/scripts/check-core-bundle-budget.mjs',
        verdict: 'budget-crossed',
        reason: `the parent job passed: crossed here, by PR #${prNumber}`,
      },
    ],
    verdict: 'budget-crossed',
    claim: 'none',
    reason: 'Build & Verify (ubuntu-latest): crossed',
    ruleVersion: 2,
  };
}

async function seed(): Promise<{ epic: string; task: string }> {
  const epic = await addTask(
    { title: 'core work', description: 'epic', type: 'epic', skipContainmentInvariant: true },
    root,
    env.accessor,
  );
  const task = await addTask(
    {
      title: 'the crossing change',
      description: 'a task under the epic',
      acceptance: ['it ships'],
      parentId: epic.task.id,
      forceDuplicate: true,
    },
    root,
    env.accessor,
  );
  return { epic: epic.task.id, task: task.task.id };
}

describe('budget-crossed files one fix task (T14254 AC2)', () => {
  it('files exactly one main-over-budget task naming the PR, and a second crossing reuses it', async () => {
    const { epic, task } = await seed();
    const first = await fileMainBudgetTasks(root, crossed(1726), task);
    expect(first.tasks).toHaveLength(1);
    const fix = await env.accessor.loadSingleTask(first.tasks[0] ?? '');
    expect(fix?.title).toBe('Main over budget: check-core-bundle-budget (crossed by PR #1726)');
    expect(fix?.parentId).toBe(epic);
    expect(fix?.labels).toContain(MAIN_OVER_BUDGET_LABEL);
    const second = await fileMainBudgetTasks(root, crossed(1800), task);
    expect(second.tasks).toEqual(first.tasks);
    const open = await env.accessor.queryTasks({ label: MAIN_OVER_BUDGET_LABEL });
    expect(open.tasks).toHaveLength(1);
    // The crossing PR's own task is untouched: it closes as it would.
    expect((await env.accessor.loadSingleTask(task))?.status).toBe('pending');
  });

  it('a PR naming no task under an epic files none and says why', async () => {
    const result = await fileMainBudgetTasks(root, crossed(1726), null);
    expect(result).toEqual({
      tasks: [],
      skipped:
        'check-core-bundle-budget: PR #1726 names no task under an epic to file the fix task in',
    });
  });

  it('a receipt that crossed no budget files nothing', async () => {
    const { task } = await seed();
    const receipt = { ...crossed(1), failures: [], verdict: 'main-health' as const };
    expect(await fileMainBudgetTasks(root, receipt, task)).toEqual({ tasks: [] });
  });
});
