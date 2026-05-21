/**
 * CLI saga command group — Saga management (above-epic grouping tier).
 *
 * A Saga is a labeled top-level Epic (label='saga') that groups member Epics
 * via `task_relations.type='groups'`. This is a thin CLI surface over existing
 * `tasks.add`, `tasks.relates.add`, and `tasks.list` dispatch operations.
 *
 * Commands:
 *   cleo saga create --title <t> [--description <d>] [--acceptance <a>]
 *   cleo saga add <sagaId> <epicId>
 *   cleo saga list
 *   cleo saga members <sagaId>
 *   cleo saga rollup <sagaId>
 *
 * @see ADR-073 — Above-Epic Naming (Saga, prefix SG-)
 * @task T9521
 * @epic T9518
 */

import { parseAcceptanceCriteria } from '@cleocode/core';
import { defineCommand, showUsage } from 'citty';
import { dispatchFromCli, dispatchRaw, handleRawError } from '../../dispatch/adapters/cli.js';
import { cliOutput } from '../renderers/index.js';

/** cleo saga create — create a new Saga (labeled top-level Epic) */
const createCommand = defineCommand({
  meta: {
    name: 'create',
    description: 'Create a new Saga (labeled top-level Epic with label=saga)',
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
      },
      { command: 'saga', operation: 'tasks.saga.create' },
    );
  },
});

/** cleo saga add <sagaId> <epicId> — link a member Epic to a Saga via type='groups' */
const addCommand = defineCommand({
  meta: {
    name: 'add',
    description: 'Link a member Epic to a Saga (writes task_relations type=groups)',
  },
  args: {
    sagaId: {
      type: 'positional',
      description: 'Saga task ID (must have label=saga)',
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

/** cleo saga list — list all Sagas (labeled top-level Epics) */
const listCommand = defineCommand({
  meta: {
    name: 'list',
    description: 'List all Sagas (labeled top-level Epics)',
  },
  async run() {
    await dispatchFromCli('query', 'tasks', 'saga.list', {}, { command: 'saga' });
  },
});

/** cleo saga members <sagaId> — list all member Epics linked to a Saga */
const membersCommand = defineCommand({
  meta: {
    name: 'members',
    description: 'List all member Epics linked to a Saga via type=groups',
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
    list: listCommand,
    members: membersCommand,
    rollup: rollupCommand,
  },
  async run({ cmd, rawArgs }) {
    const firstArg = rawArgs?.find((a) => !a.startsWith('-'));
    if (firstArg && cmd.subCommands && firstArg in cmd.subCommands) return;
    await showUsage(cmd);
  },
});
