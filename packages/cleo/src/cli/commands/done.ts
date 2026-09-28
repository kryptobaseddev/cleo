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

/**
 * `cleo done <id> [--plan] [--satisfies AC1,AC3|all] [--pr <n>] [complete flags]`.
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
    const recorded = await recordTaskDone(args.taskId, options);
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
      completeDispatchParams(args),
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
