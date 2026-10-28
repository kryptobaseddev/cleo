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
import { withoutOutputPointer } from '../field-context.js';
import { defineCommand } from '../lib/define-cli-command.js';
import { negatedFlag } from '../lib/negated-flag.js';
import { cliError, cliOutput } from '../renderers/index.js';
import { completeCommandArgs, completeDispatchParams } from './complete.js';

/**
 * One batch entry: a blocked record, or a recorded task and its completion
 * through `tasks.complete`. Shared with `cleo goal close` (T13794).
 */
export async function doneBatchEntry(
  taskId: string,
  result: Awaited<ReturnType<typeof import('@cleocode/core/tasks/done-record.js').recordTaskDone>>,
  args: { taskId: string; [flag: string]: unknown },
): Promise<Record<string, unknown>> {
  if (!result.success) {
    const { code, message, fix } = result.error;
    return { taskId, completed: false, error: code, message, next: fix };
  }
  const params = completeDispatchParams({ ...args, taskId, 'if-match': undefined });
  // T12839: --field addresses the done envelope, never this internal step.
  const done = await withoutOutputPointer(() => dispatchRaw('mutate', 'tasks', 'complete', params));
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
    results.push(await doneBatchEntry(taskId, result, args));
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
 * `cleo done --from-merge <pr|all>` (T14101): close the tasks merged PRs name
 * (`Closes:` / `Refs:` lines), or with `--receipt`, judge one PR without a
 * task store (the CI job's half). The logic lives in core `merge-close.ts`.
 */
async function fromMergeCommand(args: Record<string, unknown>, projectRoot: string): Promise<void> {
  const target = String(args['from-merge']);
  const prNumber = /^\d+$/.test(target) ? Number(target) : null;
  if (prNumber === null && target !== 'all') {
    cliError(`--from-merge takes a PR number or "all", got "${target}"`, 'E_INVALID_INPUT');
    process.exitCode = 2;
    return;
  }
  const mergeClose = await import('@cleocode/core/tasks/merge-close.js');
  // A detached lazy sweep (cli/index.ts) must not outlive a hung gh.
  if (process.env['CLEO_MERGE_SWEEP_CHILD'] === '1')
    setTimeout(() => process.exit(124), mergeClose.MERGE_SWEEP_CHILD_TIMEOUT_MS).unref();
  if (args.receipt === true) {
    const judged =
      prNumber === null
        ? null
        : await mergeClose.mergeReceiptFor(projectRoot, prNumber, {
            comment: args.comment === true,
          });
    if (judged === null) {
      cliError(
        `--receipt needs one merged PR number that gh can read (got "${target}")`,
        'E_NOT_FOUND',
      );
      process.exitCode = 4;
      return;
    }
    return cliOutput(judged, { command: 'done', operation: 'tasks.done.receipt' });
  }
  const result = await mergeClose.sweepMergedClosures(projectRoot, {
    force: true,
    ...(prNumber !== null ? { prNumbers: [prNumber] } : {}),
    ...(typeof args.since === 'string' ? { since: args.since } : {}),
    ...(args['dry-run'] === true ? { dryRun: true } : {}),
  });
  cliOutput(result, { command: 'done', operation: 'tasks.done.fromMerge' });
}

/**
 * `cleo done <id> [<id>…] [--plan] [--satisfies AC1,AC3|all] [--pr <n> | --commit <sha>] [complete flags]`.
 */
export const doneCommand = defineCommand({
  meta: {
    name: 'done',
    description:
      'Record every required gate from derived evidence (change set, tools, typed gates, AC links) in one write, then complete. --plan: read-only plan; writes nothing',
  },
  args: {
    ...completeCommandArgs,
    taskId: {
      ...completeCommandArgs.taskId,
      required: false,
      description: 'ID of the task to record and complete (omit with --from-merge)',
    },
    'from-merge': {
      type: 'string',
      description:
        'Close the tasks a merged PR names (T14101): "<pr>" for one PR, "all" for every PR merged since the last sweep. Reads the body\'s "Closes: T#### AC1,AC2" (complete once merged PRs bind every criterion) and "Refs: T#### AC1" (bind, stay open) lines; needs green required checks on the PR head and evidence.ciSatisfies. Idempotent; refusals are commented on the PR once.',
    },
    since: {
      type: 'string',
      description: 'With --from-merge all: only PRs merged at or after this ISO time',
    },
    'dry-run': {
      type: 'boolean',
      description:
        'With --from-merge: print what would be recorded; record, complete and comment nothing',
    },
    receipt: {
      type: 'boolean',
      description:
        "With --from-merge <pr>: judge the PR without a task store (the CI job's half) and print its receipt",
    },
    comment: {
      type: 'boolean',
      description: 'With --receipt: post the receipt on the PR',
    },
    'if-match': {
      type: 'string',
      description:
        'Refuse with E_CONFLICT, before recording any gate, unless the task updatedAt still equals this version (from cleo show). One task id only.',
    },
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
    commit: {
      type: 'string',
      description:
        "The commit that implements the task, already on the default branch, when no PR or branch cites it (T13799). Verified: it must exist and have landed, and its message must cite the task or its diff touch the task's declared files (a declared directory such as src/ accepts any commit under it; a glob ties only through the message); its own diff becomes the change set",
    },
    'run-typed': {
      type: 'boolean',
      description:
        "Execute the task's typed gates before recording. Without it cleo done executes no typed gate command: it uses passes cached by `cleo verify --run` (T13521).",
    },
    'shared-evidence': {
      type: 'boolean',
      description:
        'Acknowledge that the same evidence atom (e.g. ci:<pr>) is applied to >3 tasks in this session, as `cleo verify --shared-evidence` does (T14072). Without it the reuse warns W_EVIDENCE_AUDIT_MISS; under CLEO_STRICT_EVIDENCE=1 it is refused.',
    },
  },
  async run({ args: raw }) {
    if (raw['from-merge'] !== undefined) {
      const { getProjectRoot } = await import('@cleocode/core/paths.js');
      return fromMergeCommand(raw, getProjectRoot());
    }
    if (typeof raw.taskId !== 'string' || raw.taskId === '') {
      cliError('cleo done needs a task id (or --from-merge <pr|all>)', 'E_INVALID_INPUT');
      process.exitCode = 2;
      return;
    }
    const args = { ...raw, taskId: raw.taskId };
    const { parseDoneOptions, planTaskDone } = await import('@cleocode/core/tasks/done-plan.js');
    const parsed = parseDoneOptions(args.satisfies, args.pr, args.commit);
    if (!parsed.ok) {
      cliError(parsed.message, 'E_INVALID_INPUT');
      process.exitCode = 2;
      return;
    }
    const { getProjectRoot } = await import('@cleocode/core/paths.js');
    const options = {
      projectRoot: getProjectRoot(),
      ...parsed.options,
      ...(args['run-typed'] === true ? { runTyped: true } : {}),
      ...(args['shared-evidence'] === true ? { sharedEvidence: true } : {}),
      // T14053: the plan shows integration as skipped under --no-integrate.
      ...(negatedFlag(args, 'integrate') ? { noIntegrate: true } : {}),
    };
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
          fix: 'Pass one task id per call: cleo done <id> --if-match <updatedAt>',
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
    // T12839: --field addresses the done envelope; handing it to this
    // internal step let the mutate middleware refuse the completion after
    // every gate was recorded.
    const completed = await withoutOutputPointer(() =>
      dispatchRaw(
        'mutate',
        'tasks',
        'complete',
        completeDispatchParams({ ...args, 'if-match': undefined }),
      ),
    );
    if (!completed.success) {
      const details: Omit<DoneBlockedDetails, 'plan'> = {
        blocker: 'completion-refused',
        cause: completed.error?.code,
        next: {
          // T13648: keep the explicit PR carrier; `cleo complete` has no --pr.
          command:
            completed.error?.fix ??
            (args.pr === undefined
              ? `cleo complete ${args.taskId}`
              : `cleo done ${args.taskId} --pr ${args.pr}`),
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
