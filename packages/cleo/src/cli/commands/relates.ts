/**
 * CLI relates command group — task relationship management.
 *
 * Commands:
 *   cleo relates suggest <taskId>              — suggest related tasks
 *   cleo relates add <from> <to> <type> <reason> — add a relationship
 *   cleo relates remove <from> <to>            — remove a relationship
 *   cleo relates discover <taskId>             — discover related tasks
 *   cleo relates list <taskId>                 — list existing relationships
 *
 * @task T4538
 * @epic T4454
 * @task T9240
 */

import { defineCommand, showUsage } from 'citty';
import { dispatchFromCli } from '../../dispatch/adapters/cli.js';

/** cleo relates suggest — suggest related tasks based on shared attributes */
const suggestCommand = defineCommand({
  meta: { name: 'suggest', description: 'Suggest related tasks based on shared attributes' },
  args: {
    taskId: {
      type: 'positional',
      description: 'Task ID to find suggestions for',
      required: true,
    },
    threshold: {
      type: 'string',
      description: 'Minimum similarity threshold (0-100)',
      default: '50',
    },
  },
  async run({ args }) {
    await dispatchFromCli(
      'query',
      'tasks',
      'relates',
      {
        taskId: args.taskId,
        mode: 'suggest',
        threshold: Number(args.threshold),
      },
      { command: 'relates' },
    );
  },
});

/** cleo relates add — add a relates entry between two tasks */
const addCommand = defineCommand({
  meta: {
    name: 'add',
    description:
      'Add a relates entry to a task. Valid types: blocks|related|duplicates|absorbs|fixes|extends|supersedes',
  },
  args: {
    from: {
      type: 'positional',
      description: 'Source task ID',
      required: true,
    },
    to: {
      type: 'positional',
      description: 'Target task ID',
      required: true,
    },
    type: {
      type: 'positional',
      description: 'Relationship type (blocks|related|duplicates|absorbs|fixes|extends|supersedes)',
      required: true,
    },
    reason: {
      type: 'positional',
      description: 'Reason for the relationship',
      required: true,
    },
  },
  async run({ args }) {
    await dispatchFromCli(
      'mutate',
      'tasks',
      'relates.add',
      { taskId: args.from, relatedId: args.to, type: args.type, reason: args.reason },
      { command: 'relates' },
    );
  },
});

/** cleo relates discover — discover related tasks using various methods */
const discoverCommand = defineCommand({
  meta: { name: 'discover', description: 'Discover related tasks using various methods' },
  args: {
    taskId: {
      type: 'positional',
      description: 'Task ID to discover relations for',
      required: true,
    },
  },
  async run({ args }) {
    await dispatchFromCli(
      'query',
      'tasks',
      'relates',
      {
        taskId: args.taskId,
        mode: 'discover',
      },
      { command: 'relates' },
    );
  },
});

/** cleo relates remove — remove a relates entry between two tasks */
const removeCommand = defineCommand({
  meta: {
    name: 'remove',
    description: 'Remove a relates entry between two tasks',
  },
  args: {
    from: {
      type: 'positional',
      description: 'Source task ID',
      required: true,
    },
    to: {
      type: 'positional',
      description: 'Target task ID',
      required: true,
    },
    type: {
      type: 'string',
      description: 'Relation type to remove (omit to remove any type)',
      required: false,
    },
  },
  async run({ args }) {
    await dispatchFromCli(
      'mutate',
      'tasks',
      'relates.remove',
      { taskId: args.from, relatedId: args.to, type: args.type },
      { command: 'relates' },
    );
  },
});

/** cleo relates list — show existing relates entries for a task */
const listCommand = defineCommand({
  meta: { name: 'list', description: 'Show existing relates entries for a task' },
  args: {
    taskId: {
      type: 'positional',
      description: 'Task ID to list relations for',
      required: true,
    },
    type: {
      type: 'string',
      description: 'Filter by relation type (or depends/depends_on)',
      required: false,
    },
    direction: {
      type: 'string',
      description: 'Filter direction: out|in|both (default: both)',
      default: 'both',
      required: false,
    },
    noDepends: {
      type: 'boolean',
      description: 'Hide scheduler dependency edges from relation list output',
      required: false,
    },
  },
  async run({ args }) {
    await dispatchFromCli(
      'query',
      'tasks',
      'relates',
      {
        taskId: args.taskId,
        type: args.type,
        direction: args.direction,
        includeDependencies: !args.noDepends,
      },
      { command: 'relates' },
    );
  },
});

/**
 * Root relates command group — semantic relationship discovery and management between tasks.
 *
 * Dispatches to `tasks.relates` and `tasks.relates.add` registry operations.
 */
export const relatesCommand = defineCommand({
  meta: {
    name: 'relates',
    description: 'Semantic relationship discovery and management between tasks',
  },
  subCommands: {
    suggest: suggestCommand,
    add: addCommand,
    remove: removeCommand,
    discover: discoverCommand,
    list: listCommand,
  },
  async run({ cmd, rawArgs }) {
    const firstArg = rawArgs?.find((a) => !a.startsWith('-'));
    if (firstArg && cmd.subCommands && firstArg in cmd.subCommands) return;
    await showUsage(cmd);
  },
});
