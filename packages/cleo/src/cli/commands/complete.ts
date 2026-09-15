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

    // gh#1411: when the mutate-projection middleware has already reduced the
    // payload to the minimal envelope, pass it through UNCHANGED.
    //
    // `createMutateMinimalEnvelope` stamps `meta.mutateProjection` for exactly
    // this decision — its docblock says the stamp exists "so consumers can
    // distinguish a minimal envelope from a full record without
    // re-implementing the policy". This handler was the one consumer that
    // re-implemented it, and got it wrong.
    //
    // The line below used to read `data?.task ?? data`, under a comment
    // saying the engine "may return {task: {...}} or the task record
    // directly". Post-T9931 it returns neither: it returns a mutation
    // envelope `{count, created, updated, deleted, ids, ...}`. `data.task` is
    // then undefined, so the fallback took the whole envelope and nested it
    // AGAIN under `task` — putting the task id at `/data/task/updated/0`
    // while `--field` resolves against the flat projected shape. Every
    // documented pointer missed, including the three the resulting
    // E_FIELD_NOT_FOUND recommended, so an agent following the `fix` field
    // re-ran the failing command verbatim.
    //
    // `cleo update` was unaffected because it passes `response.data` straight
    // to `cliOutput` (update.ts). `complete` was the only command in the CLI
    // that rewrapped, which is why the sibling-verb control in gh#1411 showed
    // identical pointers resolving there and failing here.
    if (response.meta.mutateProjection === 'mvi') {
      cliOutput(response.data, { command: 'complete', operation: 'tasks.complete' });
      return;
    }

    // Verbose path (`--full` / `--verbose` / `--human`): the engine's own
    // `{task: {...}}` shape is the contract, and the diagnostic keys below
    // survive because no projection stripped them.
    const task = data?.task ?? data;
    const output: Record<string, unknown> = { task };
    // T12102 (gh#1196) — idempotent complete: surface the no-op marker +
    // note so the agent sees "already done, nothing to do" with exit 0.
    if (data?.alreadyDone === true) {
      output['alreadyDone'] = true;
    }
    if (typeof data?.note === 'string') {
      output['note'] = data.note;
    }
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
