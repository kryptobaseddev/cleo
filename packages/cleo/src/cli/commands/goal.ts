/**
 * CLI `cleo goal` — the goal protocol verbs (epic T13791).
 *
 * CLEO owns the goal protocol; OpenCode-Goal is the goal runtime (owner
 * decision 2026-10-16). These verbs are the protocol's CLI surface; CLEO's
 * own goal loop and its `set`/`advance`/`subgoal`/`append` verbs were retired
 * in T13797; `status` now reads the runtime's goal runs.
 *
 *   - `cleo goal draft <taskId> [--tasks …] [--out <path>]` — write a goal/v1
 *     draft from task acceptance criteria (T13793).
 *   - `cleo goal close <slug> --outcome <file>` — record a run's per-AC
 *     evidence and complete fully proven tasks via `cleo done` (T13794).
 *   - `cleo goal status [--task T123]` — the project's goal runs and the tasks
 *     they serve, read-only from the runtime's files (T13821).
 *
 * Handlers are thin: the logic lives in `@cleocode/core/goal/*`.
 *
 * @epic T13791
 * @task T13797
 */

import { ExitCode } from '@cleocode/contracts/exit-codes.js';
import { getProjectRoot } from '@cleocode/core';
import { defineCommand, showUsage } from '../lib/define-cli-command.js';
import { cliError, cliOutput } from '../renderers/index.js';

/**
 * `cleo goal draft <taskId> [--tasks T2,T3] [--out <path>]` — write a goal/v1
 * draft from the tasks' acceptance criteria. Never starts a run; refuses to
 * overwrite an existing file.
 *
 * @task T13793
 */
const draftCommand = defineCommand({
  meta: {
    name: 'draft',
    description:
      "Write a goal/v1 draft (goal.yaml) from tasks' acceptance criteria. Never starts a run or overwrites a file.",
  },
  args: {
    taskId: { type: 'positional', description: 'Primary task id (names the goal)' },
    tasks: { type: 'string', description: 'More task ids the goal serves, comma-separated' },
    out: {
      type: 'string',
      description:
        'Output file <id>/goal.yaml inside the project; <id> becomes the goal id (default .opencode/goals/<slug>/goal.yaml)',
    },
  },
  async run({ args }) {
    const ids = [
      ...new Set(
        [String(args.taskId ?? ''), ...String(args.tasks ?? '').split(',')]
          .map((s) => s.trim())
          .filter(Boolean),
      ),
    ];
    const { draftGoal } = await import('@cleocode/core/goal/draft.js');
    const result = await draftGoal(ids, {
      projectRoot: getProjectRoot(),
      ...(typeof args.out === 'string' && args.out ? { out: args.out } : {}),
    });
    if (!result.success) {
      cliError(result.error.message, result.error.code, { fix: result.error.fix });
      process.exitCode = result.error.exitCode ?? 1;
      return;
    }
    cliOutput(result.data, { command: 'goal draft', operation: 'goal.draft' });
  },
});

/**
 * `cleo goal close <slug> --outcome <file>` — verify a goal run's outcome
 * against its contract, record per-AC evidence, then complete every task whose
 * criteria are all mapped through the `cleo done` path. Open criteria are
 * named per task; nothing is completed on their behalf.
 *
 * @task T13794
 */
const closeCommand = defineCommand({
  meta: {
    name: 'close',
    description:
      "Record a goal run's per-AC evidence from its outcome file, then complete each task whose criteria are all proven (via cleo done)",
  },
  args: {
    slug: { type: 'positional', description: 'Goal slug (.opencode/goals/<slug>/goal.yaml)' },
    outcome: {
      type: 'string',
      description: 'Path of the goal-outcome/v1 JSON file',
      required: true,
    },
  },
  async run({ args }) {
    const slug = String(args.slug ?? '').trim();
    if (!slug || typeof args.outcome !== 'string' || !args.outcome) {
      cliError('goal close needs <slug> and --outcome <file>', ExitCode.VALIDATION_ERROR, {
        name: 'E_VALIDATION',
      });
      return;
    }
    const projectRoot = getProjectRoot();
    const { closeGoal } = await import('@cleocode/core/goal/close.js');
    const closed = await closeGoal(slug, { projectRoot, outcomePath: args.outcome });
    if (!closed.success) {
      cliError(closed.error.message, closed.error.code, { fix: closed.error.fix });
      process.exitCode = closed.error.exitCode ?? 1;
      return;
    }
    const ready = closed.data.tasks.filter((t) => t.ready).map((t) => t.taskId);
    const completions: Array<Record<string, unknown>> = [];
    if (ready.length > 0) {
      const { recordTasksDone } = await import('@cleocode/core/tasks/done-record.js');
      const { doneBatchEntry } = await import('./done.js');
      for (const { taskId, result } of await recordTasksDone(ready, { projectRoot })) {
        completions.push(await doneBatchEntry(taskId, result, { taskId }));
      }
    }
    cliOutput(
      {
        ...closed.data,
        tasks: closed.data.tasks.map((t) => ({
          ...t,
          completion: completions.find((c) => c.taskId === t.taskId) ?? null,
        })),
      },
      { command: 'goal close', operation: 'goal.close' },
    );
  },
});

/**
 * `cleo goal status [--task T123]` — the project's goal/v1 runs and the tasks
 * they serve, read-only from the goal runtime's files (T13821).
 *
 * @task T13821
 */
const statusCommand = defineCommand({
  meta: {
    name: 'status',
    description:
      "Show the project's goal runs (OpenCode-Goal) and the CLEO tasks each serves, read-only; --task filters to one task",
  },
  args: {
    task: { type: 'string', description: 'Only goals serving this task (T123)' },
  },
  async run({ args }) {
    const { goalStatus } = await import('@cleocode/core/goal/status.js');
    const goals = goalStatus({
      projectRoot: getProjectRoot(),
      ...(typeof args.task === 'string' && args.task ? { taskId: args.task } : {}),
    });
    cliOutput({ goals }, { command: 'goal status', operation: 'goal.status' });
  },
});

/**
 * Parent `cleo goal` command — routes to the protocol verbs `draft`, `close`
 * and `status`; prints usage when invoked bare.
 *
 * @task T13797
 */
export const goalCommand = defineCommand({
  meta: {
    name: 'goal',
    description:
      'Goal protocol verbs for the goal runtime (OpenCode-Goal): draft a goal/v1 contract from task ACs, close a run from its outcome, show run status.',
  },
  subCommands: {
    draft: draftCommand,
    close: closeCommand,
    status: statusCommand,
  },
  async run({ cmd, rawArgs }) {
    const firstArg = rawArgs?.find((a) => !a.startsWith('-'));
    if (firstArg && cmd.subCommands && firstArg in cmd.subCommands) return;
    await showUsage(cmd);
  },
});
