/**
 * CLI command group for project-level phase lifecycle management.
 *
 * Exposes phase operations as a native citty subcommand group:
 *
 *   cleo phase show [slug]        — show phase details
 *   cleo phase list               — list all phases with status
 *   cleo phase set <slug>         — set current phase
 *   cleo phase start <slug>       — start a phase (pending → active)
 *   cleo phase complete <slug>    — complete a phase (active → completed)
 *   cleo phase advance            — complete current phase and start next
 *   cleo phase rename <old> <new> — rename a phase
 *   cleo phase delete <slug>      — delete a phase
 *
 * Alias `pipeline` is wired in index.ts.
 *
 * @task T4464, T5326
 * @epic T4454, T5323
 */

import { defineCommand, showUsage } from 'citty';
import { dispatchFromCli } from '../../dispatch/adapters/cli.js';

/** cleo phase show — show phase details (current phase if no slug given) */
const showCommand = defineCommand({
  meta: { name: 'show', description: 'Show phase details (current phase if no slug given)' },
  args: {
    slug: {
      type: 'positional',
      description: 'Phase slug (defaults to current phase)',
      required: false,
    },
  },
  async run({ args }) {
    const params = args.slug ? { phaseId: args.slug } : {};
    await dispatchFromCli('query', 'pipeline', 'phase.show', params, { command: 'phase' });
  },
});

/** cleo phase list — list all phases with status */
const listCommand = defineCommand({
  meta: { name: 'list', description: 'List all phases with status' },
  async run() {
    await dispatchFromCli('query', 'pipeline', 'phase.list', {}, { command: 'phase' });
  },
});

/** cleo phase set — set current phase */
const setCommand = defineCommand({
  meta: { name: 'set', description: 'Set current phase' },
  args: {
    slug: {
      type: 'positional',
      description: 'Phase slug to set as current',
      required: true,
    },
    rollback: {
      type: 'boolean',
      description: 'Allow backward phase movement',
    },
    force: {
      type: 'boolean',
      description: 'Skip confirmation prompt',
    },
    'dry-run': {
      type: 'boolean',
      description: 'Preview changes without modifying files',
    },
  },
  async run({ args }) {
    await dispatchFromCli(
      'mutate',
      'pipeline',
      'phase.set',
      {
        phaseId: args.slug,
        rollback: args.rollback,
        force: args.force,
        dryRun: args['dry-run'],
      },
      { command: 'phase' },
    );
  },
});

/** cleo phase start — start a phase (pending → active) */
const startCommand = defineCommand({
  meta: { name: 'start', description: 'Start a phase (pending -> active)' },
  args: {
    slug: {
      type: 'positional',
      description: 'Phase slug to start',
      required: true,
    },
  },
  async run({ args }) {
    await dispatchFromCli(
      'mutate',
      'pipeline',
      'phase.set',
      { phaseId: args.slug, action: 'start' },
      { command: 'phase' },
    );
  },
});

/** cleo phase complete — complete a phase (active → completed) */
const completeCommand = defineCommand({
  meta: { name: 'complete', description: 'Complete a phase (active -> completed)' },
  args: {
    slug: {
      type: 'positional',
      description: 'Phase slug to complete',
      required: true,
    },
  },
  async run({ args }) {
    await dispatchFromCli(
      'mutate',
      'pipeline',
      'phase.set',
      { phaseId: args.slug, action: 'complete' },
      { command: 'phase' },
    );
  },
});

/** cleo phase advance — complete current phase and start next */
const advanceCommand = defineCommand({
  meta: { name: 'advance', description: 'Complete current phase and start next' },
  args: {
    force: {
      type: 'boolean',
      description: 'Skip validation and interactive prompt',
      alias: 'f',
    },
  },
  async run({ args }) {
    await dispatchFromCli(
      'mutate',
      'pipeline',
      'phase.advance',
      { force: args.force },
      { command: 'phase' },
    );
  },
});

/** cleo phase rename — rename a phase and update all task references */
const renameCommand = defineCommand({
  meta: { name: 'rename', description: 'Rename a phase and update all task references' },
  args: {
    oldName: {
      type: 'positional',
      description: 'Current phase name',
      required: true,
    },
    newName: {
      type: 'positional',
      description: 'New phase name',
      required: true,
    },
  },
  async run({ args }) {
    await dispatchFromCli(
      'mutate',
      'pipeline',
      'phase.rename',
      { oldName: args.oldName, newName: args.newName },
      { command: 'phase' },
    );
  },
});

/** cleo phase delete — delete a phase with task reassignment protection */
const deleteCommand = defineCommand({
  meta: { name: 'delete', description: 'Delete a phase with task reassignment protection' },
  args: {
    slug: {
      type: 'positional',
      description: 'Phase slug to delete',
      required: true,
    },
    'reassign-to': {
      type: 'string',
      description: 'Reassign tasks to another phase',
    },
    force: {
      type: 'boolean',
      description: 'Required safety flag',
    },
  },
  async run({ args }) {
    await dispatchFromCli(
      'mutate',
      'pipeline',
      'phase.delete',
      {
        phaseId: args.slug,
        reassignTo: args['reassign-to'],
        force: args.force,
      },
      { command: 'phase' },
    );
  },
});

/**
 * Root phase command group — project-level phase lifecycle management.
 *
 * Dispatches to the `pipeline` domain. The `pipeline` alias is wired in index.ts.
 *
 * @task T4464, T5326
 * @epic T4454, T5323
 */
export const phaseCommand = defineCommand({
  meta: { name: 'phase', description: 'Project-level phase lifecycle management' },
  subCommands: {
    show: showCommand,
    list: listCommand,
    set: setCommand,
    start: startCommand,
    complete: completeCommand,
    advance: advanceCommand,
    rename: renameCommand,
    delete: deleteCommand,
  },
  async run({ cmd }) {
    await showUsage(cmd);
  },
});
