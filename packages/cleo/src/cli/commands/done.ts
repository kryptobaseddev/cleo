/**
 * CLI done command — record every required gate from derived evidence, then
 * complete (`cleo done <id>`), or print the read-only plan (`--plan`).
 *
 * `cleo done <id>` derives the change set, runs the tools and typed gates
 * once, records every required gate the task lacks in ONE write through the
 * existing validators (`recordTaskDone`), then completes through the same
 * `tasks.complete` operation `cleo complete` dispatches. Any stop is one
 * `E_DONE_BLOCKED` envelope carrying one next step (`fix` /
 * `details.next.command`) and the original code in `details.cause`.
 * There is no override flag. The logic lives in core; this handler renders.
 *
 * @task T12623
 * @task T12625
 * @see packages/core/src/tasks/done-plan.ts
 * @see packages/core/src/tasks/done-record.ts
 */

import type { DoneBlockedDetails } from '@cleocode/contracts';
import { dispatchRaw } from '../../dispatch/adapters/cli.js';
import { defineCommand } from '../lib/define-cli-command.js';
import { cliError, cliOutput } from '../renderers/index.js';
import { completeCommandArgs, completeDispatchParams } from './complete.js';

/** One batch entry: a blocked record, or a recorded task and its completion. */
async function batchEntry(
  taskId: string,
  result: Awaited<ReturnType<typeof import('@cleocode/core/tasks/done-record.js').recordTaskDone>>,
  args: { taskId: string; [flag: string]: unknown },
): Promise<Record<string, unknown>> {
  if (!result.success) {
    const { code, message, fix } = result.error;
    return { taskId, completed: false, error: code, message, next: fix };
  }
  const params = completeDispatchParams({ ...args, taskId, 'if-match': undefined });
  const done = await dispatchRaw('mutate', 'tasks', 'complete', params);
  const recordedGates = result.data.recordedGates;
  if (done.success) return { taskId, recordedGates, completed: true };
  const failure = { error: 'E_DONE_BLOCKED', message: done.error?.message, next: done.error?.fix };
  return { taskId, recordedGates, completed: false, ...failure };
}

/**
 * Batch close (T12628): record every task (tools run once for the batch),
 * complete each recorded one through `tasks.complete`, and report one entry
 * per task. One task's blocker never stops the others; any blocked task makes
 * the envelope `E_DONE_PARTIAL` with every entry in `details.results`.
 */
async function runBatchDone(
  taskIds: string[],
  args: { taskId: string; [flag: string]: unknown },
  options: { projectRoot: string },
  plan: boolean,
): Promise<void> {
  if (plan) {
    const { planTaskDone } = await import('@cleocode/core/tasks/done-plan.js');
    const plans = await Promise.all(taskIds.map((id) => planTaskDone(id, options)));
    const data = { plans: plans.map((p, i) => ({ taskId: taskIds[i], ...p })) };
    return cliOutput(data, { command: 'done', operation: 'tasks.done.plan' });
  }
  const { recordTasksDone } = await import('@cleocode/core/tasks/done-record.js');
  const results: Array<Record<string, unknown>> = [];
  for (const { taskId, result } of await recordTasksDone(taskIds, options)) {
    results.push(await batchEntry(taskId, result, args));
  }
  const blocked = results.filter((r) => r.completed !== true);
  if (blocked.length === 0)
    return cliOutput({ results }, { command: 'done', operation: 'tasks.done' });
  const names = blocked.map((r) => r.taskId).join(', ');
  cliError(
    `${blocked.length} of ${results.length} tasks not completed: ${names}`,
    'E_DONE_PARTIAL',
    {
      details: { results },
    },
  );
  process.exitCode = 1;
}

/**
 * `cleo done <id> [<id>…] [--plan] [--satisfies AC1,AC3|all] [--pr <n>] [complete flags]`.
 */
export const doneCommand = defineCommand({
  meta: {
    name: 'done',
    description:
      'Record every required gate from derived evidence (change set, tools, typed gates, AC links) in one write, then complete. --plan: read-only plan; writes nothing',
  },
  args: {
    ...completeCommandArgs,
    plan: {
      type: 'boolean',
      description:
        'Print the evidence plan instead: derived change set, required gates, tool runs (cache state), AC mapping, ordered blockers and runnable commands. Records and executes nothing.',
    },
    satisfies: {
      type: 'string',
      description:
        'Criteria this work satisfies, e.g. "AC1,AC3" or "all"; linked to every gate whose evidence covers them',
    },
    pr: {
      type: 'string',
      description: 'The merged PR that implements the task (skips PR selection)',
    },
  },
  async run({ args }) {
    const { parseDoneOptions, planTaskDone } = await import('@cleocode/core/tasks/done-plan.js');
    const parsed = parseDoneOptions(args.satisfies, args.pr);
    if (!parsed.ok) {
      cliError(parsed.message, 'E_INVALID_INPUT');
      process.exitCode = 2;
      return;
    }
    const { getProjectRoot } = await import('@cleocode/core/paths.js');
    const options = { projectRoot: getProjectRoot(), ...parsed.options };
    // T12628: `cleo done T1 T2 T3 [--pr N]` closes several tasks in one call.
    // Every id must be a task id — a silently dropped `t2` would report success.
    const requested = [
      ...new Set([args.taskId, ...((args._ as string[] | undefined) ?? [])].map(String)),
    ];
    const invalid = requested.filter((id) => !/^T\d+$/.test(id));
    if (invalid.length > 0) {
      cliError(`Not task ids: ${invalid.join(', ')} (expected T<digits>)`, 'E_INVALID_INPUT');
      process.exitCode = 2;
      return;
    }
    const taskIds = requested;
    // T12503: a version describes one task; `done T1 T2 --if-match v` is refused.
    const ifMatch = typeof args['if-match'] === 'string' ? args['if-match'] : undefined;
    if (ifMatch !== undefined && taskIds.length > 1) {
      cliError(
        '--if-match applies to one task; it cannot be used with several task ids',
        'E_INVALID_INPUT',
        {
          fix: 'Run cleo done <id> --if-match <updatedAt> once per task',
        },
      );
      process.exitCode = 2;
      return;
    }
    if (taskIds.length > 1) {
      await runBatchDone(taskIds, args, options, args.plan === true);
      return;
    }
    if (args.plan === true) {
      const plan = await planTaskDone(args.taskId, options);
      if (!plan.success) {
        cliError(plan.error.message, plan.error.code, { fix: plan.error.fix });
        process.exitCode = plan.error.exitCode ?? 1;
        return;
      }
      cliOutput(plan.data, { command: 'done', operation: 'tasks.done.plan' });
      return;
    }
    const { recordTaskDone } = await import('@cleocode/core/tasks/done-record.js');
    // T12503: --if-match is checked before anything is recorded. Recording the
    // gates advances the version, so completion uses its own post-record read.
    const recorded = await recordTaskDone(args.taskId, {
      ...options,
      ...(ifMatch !== undefined ? { expectedUpdatedAt: ifMatch } : {}),
    });
    if (!recorded.success) {
      cliError(recorded.error.message, recorded.error.code, {
        fix: recorded.error.fix,
        details: recorded.error.details,
      });
      process.exitCode = recorded.error.exitCode ?? 1;
      return;
    }
    const completed = await dispatchRaw(
      'mutate',
      'tasks',
      'complete',
      completeDispatchParams({ ...args, 'if-match': undefined }),
    );
    if (!completed.success) {
      const details: Omit<DoneBlockedDetails, 'plan'> = {
        blocker: 'completion-refused',
        cause: completed.error?.code,
        next: {
          command: completed.error?.fix ?? `cleo complete ${args.taskId}`,
          why: 'Every gate is recorded; completion itself was refused.',
        },
        recordedGates: recorded.data.recordedGates,
      };
      cliError(completed.error?.message ?? 'completion refused', 'E_DONE_BLOCKED', {
        fix: details.next.command,
        details,
      });
      process.exitCode = completed.error?.exitCode ?? 1;
      return;
    }
    const { plan: _plan, ...summary } = recorded.data;
    cliOutput(
      { ...summary, completed: true, complete: completed.data },
      { command: 'done', operation: 'tasks.done' },
    );
  },
});
