/**
 * CLI done command — `cleo done <id> --plan`, the read-only evidence planner.
 *
 * `cleo done <id>` without `--plan` is unchanged: it runs `cleo complete`
 * with the same arguments (the historical `done` alias). `--plan` prints what
 * the streamlined verification flow would record — the change set and its
 * source, the required gates, the tool runs and their cache state, the AC
 * mapping, the ordered blockers and the exact commands — and writes nothing.
 * The logic lives in core (`deriveTaskEvidence`); this handler only renders.
 *
 * @task T12623
 * @see packages/core/src/tasks/done-plan.ts
 */

import { defineCommand } from '../lib/define-cli-command.js';
import { cliError, cliOutput } from '../renderers/index.js';
import { completeCommand, completeCommandArgs } from './complete.js';

/**
 * `cleo done <id> [--plan [--satisfies AC1,AC3|all] [--pr <n>]]`.
 *
 * Without `--plan` it delegates to {@link completeCommand} unchanged, so the
 * `done` spelling of `complete` stays byte-compatible.
 */
export const doneCommand = defineCommand({
  meta: {
    name: 'done',
    description:
      'Complete a task (alias of complete). With --plan: read-only evidence plan — change set, gates, tool runs, AC mapping, blockers and the exact commands; writes nothing',
  },
  args: {
    ...completeCommandArgs,
    plan: {
      type: 'boolean',
      description:
        'Print the evidence plan instead of completing: derived change set, required gates, tool runs (cache state), AC mapping, ordered blockers and runnable commands. Records and executes nothing.',
    },
    satisfies: {
      type: 'string',
      description:
        'With --plan: criteria this work satisfies, e.g. "AC1,AC3" or "all"; linked to every gate whose evidence covers them',
    },
    pr: {
      type: 'string',
      description: 'With --plan: the merged PR that implements the task (skips PR discovery)',
    },
  },
  async run(context) {
    const { args } = context;
    if (args.plan !== true) {
      await completeCommand.run?.({ rawArgs: context.rawArgs, args, cmd: completeCommand });
      return;
    }
    const { planTaskDone } = await import('@cleocode/core/tasks/done-plan.js');
    const { getProjectRoot } = await import('@cleocode/core/paths.js');
    const raw = typeof args.satisfies === 'string' ? args.satisfies.trim() : '';
    const prNumber = typeof args.pr === 'string' ? Number(args.pr) : undefined;
    if (prNumber !== undefined && !(Number.isInteger(prNumber) && prNumber > 0)) {
      cliError(`--pr must be a positive PR number, got "${args.pr}"`, 'E_INVALID_INPUT');
      process.exitCode = 2;
      return;
    }
    const result = await planTaskDone(args.taskId, {
      projectRoot: getProjectRoot(),
      ...(raw === '' ? {} : { satisfies: raw.toLowerCase() === 'all' ? 'all' : raw.split(',') }),
      ...(prNumber !== undefined ? { prNumber } : {}),
    });
    if (!result.success) {
      cliError(result.error.message, result.error.code, { fix: result.error.fix });
      process.exitCode = result.error.exitCode ?? 1;
      return;
    }
    cliOutput(result.data, { command: 'done', operation: 'tasks.done.plan' });
  },
});
