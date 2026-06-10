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
import { dispatchRaw, handleRawError, maybeEmitDescribe } from '../../dispatch/adapters/cli.js';
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
    // T10509 — AC-coverage gate (load-bearing IVTR closure)
    'waive-ac': {
      type: 'string',
      description:
        'Comma-separated AC tokens (UUIDs or AC<n> aliases) to waive from the AC-coverage gate. Requires --waive-reason. Audited to .cleo/audit/ac-waiver.jsonl.',
    },
    'waive-reason': {
      type: 'string',
      description:
        'Mandatory justification text for --waive-ac. Captured verbatim in the audit row.',
    },
    // T10538 — cancelled-child waiver gate (PM-Core V2 agent-trust)
    'waive-cancelled-children': {
      type: 'string',
      description:
        'Reason for completing a parent that has cancelled children. Cancelled work does not silently satisfy completion; the reason is audited to .cleo/audit/cancelled-child-waiver.jsonl.',
    },
    // T11954 (DHQ-071) — depends-edge waiver for stale/over-specified deps
    'waive-depends': {
      type: 'string',
      description:
        'Reason for completing a task whose own work is done but whose depends edges point at not-yet-terminal tasks (stale/over-specified). Audited to .cleo/audit/depends-waiver.jsonl.',
    },
  },
  async run({ args }) {
    // T11692 (DHQ-057) — `cleo complete --describe` prints the op's I/O schema
    // (completion is a status mutation → the task lands at /data/updated/0).
    if (maybeEmitDescribe('mutate', 'tasks', 'complete', { command: 'complete' })) return;

    const response = await dispatchRaw('mutate', 'tasks', 'complete', {
      taskId: args.taskId,
      notes: args.notes as string | undefined,
      changeset: args.changeset as string | undefined,
      verificationNote: args['verification-note'] as string | undefined,
      acknowledgeRisk: args['acknowledge-risk'] as string | undefined,
      overrideReason: args['override-reason'] as string | undefined,
      // T10509 — AC-coverage gate waiver path
      waiveAc: args['waive-ac'] as string | undefined,
      waiveReason: args['waive-reason'] as string | undefined,
      // T10538 — cancelled-child waiver (PM-Core V2 agent-trust)
      cancelledChildWaiverReason: args['waive-cancelled-children'] as string | undefined,
      // T11954 (DHQ-071) — depends-edge waiver for stale/over-specified deps
      waiveDependsReason: args['waive-depends'] as string | undefined,
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
    // T9548 — surface auto-invoke worktree-complete diagnostics on the CLI
    // envelope so the operator can see what happened to the worktree (merged,
    // noop, env-disabled, conflict, etc.). The field is always present when
    // task completion succeeded; it's omitted on failure paths.
    const worktreeAutoComplete = data?.worktreeAutoComplete;
    if (worktreeAutoComplete && typeof worktreeAutoComplete === 'object') {
      output['worktreeAutoComplete'] = worktreeAutoComplete;
    }

    cliOutput(output, { command: 'complete', operation: 'tasks.complete' });
  },
});
