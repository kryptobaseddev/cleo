/**
 * CLI complete command — mark a task as completed.
 *
 * Dispatches to the `tasks.complete` registry operation.
 *
 * As of v2026.4.78 (T832 / ADR-051), the `--force` flag has been removed.
 * Gates are satisfied by evidence-based `cleo verify --gate … --evidence …`
 * and re-validated at complete time. For genuine emergencies, set
 * `CLEO_OWNER_OVERRIDE=1` with `CLEO_OWNER_OVERRIDE_REASON=<reason>` on the
 * `cleo verify` call — the override is audited.
 *
 * As of T1073, the `--acknowledge-risk` flag allows bypassing the nexusImpact gate
 * when a task touches symbols with CRITICAL impact risk. The acknowledgment is
 * audited to `.cleo/audit/nexus-risk-ack.jsonl`.
 *
 * As of T1632, `cleo complete <epicId>` is REJECTED with E_EPIC_HAS_PENDING_CHILDREN
 * when the epic has pending or active children. Pass `--override-reason "<reason>"`
 * to bypass (audited to `.cleo/audit/premature-close.jsonl`).
 *
 * @task T4461
 * @task T832
 * @task T1632
 * @adr ADR-051
 * @epic T4454
 */

import { defineCommand } from 'citty';
import { dispatchRaw, handleRawError } from '../../dispatch/adapters/cli.js';
import { cliOutput } from '../renderers/index.js';

/**
 * Complete command — marks the given task as done.
 *
 * Root alias `done` is wired in index.ts.
 */
export const completeCommand = defineCommand({
  meta: {
    name: 'complete',
    description: 'Mark a task as completed (requires active session)',
  },
  args: {
    taskId: {
      type: 'positional',
      description: 'ID of the task to complete',
      required: true,
    },
    notes: {
      type: 'string',
      description: 'Completion notes',
    },
    changeset: {
      type: 'string',
      description: 'Changeset reference',
    },
    'verification-note': {
      type: 'string',
      description: 'Evidence that acceptance criteria were met',
    },
    'acknowledge-risk': {
      type: 'string',
      description: 'Reason for acknowledging CRITICAL impact risk (bypasses nexusImpact gate)',
    },
    'override-reason': {
      type: 'string',
      description:
        'Reason for bypassing E_EPIC_HAS_PENDING_CHILDREN guard (audited to .cleo/audit/premature-close.jsonl)',
    },
  },
  async run({ args }) {
    const response = await dispatchRaw('mutate', 'tasks', 'complete', {
      taskId: args.taskId,
      notes: args.notes as string | undefined,
      changeset: args.changeset as string | undefined,
      verificationNote: args['verification-note'] as string | undefined,
      acknowledgeRisk: args['acknowledge-risk'] as string | undefined,
      overrideReason: args['override-reason'] as string | undefined,
    });

    if (!response.success) {
      handleRawError(response, { command: 'complete', operation: 'tasks.complete' });
    }

    const data = response.data as Record<string, unknown> | undefined;
    // Engine may return {task: {...}} or the task record directly
    const task = data?.task ?? data;
    const output: Record<string, unknown> = { task };
    const autoCompleted = data?.autoCompleted;
    if (Array.isArray(autoCompleted) && autoCompleted.length > 0) {
      output['autoCompleted'] = autoCompleted;
    }
    const unblockedTasks = data?.unblockedTasks;
    if (Array.isArray(unblockedTasks) && unblockedTasks.length > 0) {
      output['unblockedTasks'] = unblockedTasks;
    }

    cliOutput(output, { command: 'complete', operation: 'tasks.complete' });
  },
});
