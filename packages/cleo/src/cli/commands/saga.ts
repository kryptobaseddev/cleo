/**
 * CLI saga command group — Saga management (above-epic grouping tier).
 *
 * A Saga is a top-level task (`type='saga'`) that groups member Epics via
 * `parent_id` containment. This is a thin CLI surface over existing
 * `tasks.add`, `tasks.relates.add`, and `tasks.list` dispatch operations.
 *
 * Commands:
 *   cleo saga create --title <t> [--description <d>] [--acceptance <a>]
 *   cleo saga add <sagaId> <epicId>
 *   cleo saga detach <sagaId> <memberId> [--reason "..."]
 *   cleo saga list
 *   cleo saga members <sagaId>
 *   cleo saga rollup <sagaId>
 *   cleo saga repair <sagaId>
 *   cleo saga reconcile [<sagaId>] [--dry-run]
 *
 * @see ADR-073 — Above-Epic Naming (Saga, prefix SG-)
 * @task T9521
 * @task T10117 — saga repair verb
 * @task T10118 — `detach` verb wired for ADR-073 §1.2 I7 repair
 * @task T10121 — `reconcile` verb (idempotent cron-safe auto-close)
 * @epic T9518
 * @epic T10209 — E-SAGA-ENFORCEMENT
 * @epic T10210 — E-SAGA-AUTO-CLOSE
 */

import { parseAcceptanceCriteria } from '@cleocode/core';
import { defineCommand, showUsage } from 'citty';
import { dispatchFromCli, dispatchRaw, handleRawError } from '../../dispatch/adapters/cli.js';
import { cliOutput } from '../renderers/index.js';

/** cleo saga create — create a new Saga (type='saga') */
const createCommand = defineCommand({
  meta: {
    name: 'create',
    description: "Create a new Saga (top-level task with type='saga')",
  },
  args: {
    title: {
      type: 'string',
      description: 'Saga title',
      required: true,
    },
    description: {
      type: 'string',
      description: 'Saga description',
      required: false,
    },
    acceptance: {
      type: 'string',
      description: 'Pipe-separated acceptance criteria (e.g. "AC1|AC2")',
      required: false,
    },
    'dry-run': {
      type: 'boolean',
      description: 'Validate and preview the Saga without writing task, relation, or doc rows',
      required: false,
    },
  },
  async run({ args }) {
    await dispatchFromCli(
      'mutate',
      'tasks',
      'saga.create',
      {
        title: args.title,
        description: args.description,
        // T9839/gh-409: route through bracket+quote-aware parser so criteria
        // containing `ENUM (a|b|c)` or quoted unions aren't shredded.
        acceptance: args.acceptance ? parseAcceptanceCriteria(args.acceptance) : undefined,
        dryRun: args['dry-run'] === true,
      },
      { command: 'saga', operation: 'tasks.saga.create' },
    );
  },
});

/** cleo saga add <sagaId> <epicId> — link a member Epic to a Saga via parent_id */
const addCommand = defineCommand({
  meta: {
    name: 'add',
    description: 'Link a member Epic to a Saga via parent_id containment',
  },
  args: {
    sagaId: {
      type: 'positional',
      description: "Saga task ID (must have type='saga')",
      required: true,
    },
    epicId: {
      type: 'positional',
      description: 'Epic task ID to add as a member',
      required: true,
    },
  },
  async run({ args }) {
    await dispatchFromCli(
      'mutate',
      'tasks',
      'saga.add',
      { sagaId: args.sagaId, epicId: args.epicId },
      { command: 'saga', operation: 'tasks.saga.add' },
    );
  },
});

/**
 * cleo saga detach <sagaId> <memberId> — clear a Saga member parent_id edge.
 * Idempotent (no-op if already removed). Always appends to
 * `.cleo/audit/saga-detach.jsonl`. Primary use case: repair an ADR-073 §1.2
 * I7 violation where a saga was linked as a member of another saga.
 *
 * @task T10118
 */
const detachCommand = defineCommand({
  meta: {
    name: 'detach',
    description:
      'Remove a Saga member via parent_id containment — idempotent, audit-logged',
  },
  args: {
    sagaId: {
      type: 'positional',
      description: 'Saga task ID',
      required: true,
    },
    memberId: {
      type: 'positional',
      description: 'Member task ID to detach from the Saga',
      required: true,
    },
    reason: {
      type: 'string',
      description: 'Human-readable reason recorded in the audit log entry',
      required: false,
    },
  },
  async run({ args }) {
    await dispatchFromCli(
      'mutate',
      'tasks',
      'saga.detach',
      { sagaId: args.sagaId, memberId: args.memberId, reason: args.reason },
      { command: 'saga', operation: 'tasks.saga.detach' },
    );
  },
});

/** cleo saga list — list all Sagas */
const listCommand = defineCommand({
  meta: {
    name: 'list',
    description: 'List all Sagas',
  },
  async run() {
    await dispatchFromCli('query', 'tasks', 'saga.list', {}, { command: 'saga' });
  },
});

/** cleo saga members <sagaId> — list all member Epics linked to a Saga */
const membersCommand = defineCommand({
  meta: {
    name: 'members',
    description: 'List all member Epics linked to a Saga via parent_id containment',
  },
  args: {
    sagaId: {
      type: 'positional',
      description: 'Saga task ID',
      required: true,
    },
  },
  async run({ args }) {
    await dispatchFromCli(
      'query',
      'tasks',
      'saga.members',
      { sagaId: args.sagaId },
      { command: 'saga' },
    );
  },
});

/**
 * cleo saga repair <sagaId> — detach an I5-violating `parentId` from a Saga
 * by clearing the invalid Saga parent edge.
 * Idempotent.
 *
 * @task T10117
 * @see ADR-073-above-epic-naming.md §1.2 — invariant I5
 */
const repairCommand = defineCommand({
  meta: {
    name: 'repair',
    description:
      'Detach an I5-violating parentId from a Saga. Idempotent.',
  },
  args: {
    sagaId: {
      type: 'positional',
      description: "Saga task ID (must have type='saga')",
      required: true,
    },
  },
  async run({ args }) {
    await dispatchFromCli(
      'mutate',
      'tasks',
      'saga.repair',
      { sagaId: args.sagaId },
      { command: 'saga', operation: 'tasks.saga.repair' },
    );
  },
});

/**
 * cleo saga reconcile [<sagaId>] [--dry-run] — idempotent cron-safe
 * re-application of the T10116 saga auto-close logic. Walks every saga
 * (or single sagaId if supplied) and flips `status='done'` for any saga
 * whose members reached 100% terminal status via paths other than
 * `completeTask` (bulk SQL repair, crash recovery, manual state edits).
 *
 * Per-saga advisory lock + audit log at `.cleo/audit/saga-reconcile.jsonl`.
 *
 * Supersedes T10098 standalone scope.
 *
 * @task T10121
 * @see ADR-073-above-epic-naming.md §1.3
 */
const reconcileCommand = defineCommand({
  meta: {
    name: 'reconcile',
    description:
      'Idempotent cron-safe saga auto-close repair — re-applies T10116 logic for state changed outside completeTask',
  },
  args: {
    sagaId: {
      type: 'positional',
      description: 'Optional saga task ID. Omit to walk every saga.',
      required: false,
    },
    'dry-run': {
      type: 'boolean',
      description: 'Report what would happen without mutating rows or writing audit log',
      required: false,
    },
  },
  async run({ args }) {
    const sagaId =
      typeof args.sagaId === 'string' && args.sagaId.length > 0 ? args.sagaId : undefined;
    await dispatchFromCli(
      'mutate',
      'tasks',
      'saga.reconcile',
      { sagaId, dryRun: args['dry-run'] === true },
      { command: 'saga', operation: 'tasks.saga.reconcile' },
    );
  },
});

/** cleo saga rollup <sagaId> — aggregate status counts across all member Epics */
const rollupCommand = defineCommand({
  meta: {
    name: 'rollup',
    description:
      'Aggregate member Epic statuses: total/done/active/blocked/pending + completionPct',
  },
  args: {
    sagaId: {
      type: 'positional',
      description: 'Saga task ID',
      required: true,
    },
  },
  async run({ args }) {
    const response = await dispatchRaw('query', 'tasks', 'saga.rollup', {
      sagaId: args.sagaId,
    });
    handleRawError(response, { command: 'saga', operation: 'tasks.saga.rollup' });
    cliOutput(response.data ?? {}, { command: 'saga', operation: 'tasks.saga.rollup' });
  },
});

/**
 * Root saga command group — above-epic grouping tier (Saga, prefix SG-).
 *
 * Dispatches to `tasks.saga.*` registry operations.
 *
 * @see ADR-073
 */
export const sagaCommand = defineCommand({
  meta: {
    name: 'saga',
    description: 'Saga management — above-Epic grouping tier (ADR-073)',
  },
  subCommands: {
    create: createCommand,
    add: addCommand,
    detach: detachCommand,
    list: listCommand,
    members: membersCommand,
    rollup: rollupCommand,
    repair: repairCommand,
    reconcile: reconcileCommand,
  },
  async run({ cmd, rawArgs }) {
    const firstArg = rawArgs?.find((a) => !a.startsWith('-'));
    if (firstArg && cmd.subCommands && firstArg in cmd.subCommands) return;
    await showUsage(cmd);
  },
});
