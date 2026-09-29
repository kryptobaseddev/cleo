/**
 * CLI history command - completion timeline, audit log, and task work history.
 * @task T4538
 * @epic T4454
 * @task T5323
 */

import { defineCommand, showUsage } from 'citty';
import { dispatchFromCli } from '../../dispatch/adapters/cli.js';

/** cleo history log — show operation audit log with optional date range */
const logCommand = defineCommand({
  meta: { name: 'log', description: 'Show operation audit log' },
  args: {
    days: {
      type: 'string',
      description: 'Show last N days',
      default: '30',
    },
    since: {
      type: 'string',
      description: 'Show completions since date (YYYY-MM-DD)',
    },
    until: {
      type: 'string',
      description: 'Show completions until date (YYYY-MM-DD)',
    },
    'no-chart': {
      type: 'boolean',
      description: 'Disable bar charts',
      default: false,
    },
  },
  async run({ args }) {
    await dispatchFromCli(
      'query',
      'admin',
      'log',
      {
        days: Number.parseInt(args.days, 10),
        since: args.since as string | undefined,
        until: args.until as string | undefined,
      },
      { command: 'history' },
    );
  },
});

/** cleo history work — show time tracked per task */
const workCommand = defineCommand({
  meta: { name: 'work', description: 'Show task work history (time tracked per task)' },
  async run() {
    await dispatchFromCli('query', 'tasks', 'history', {}, { command: 'history' });
  },
});

/** cleo history ranking <taskId> — who changed a task's ranking inputs, and why (T12693) */
const rankingCommand = defineCommand({
  meta: {
    name: 'ranking',
    description:
      "Who changed a task's priority, severity, kind or depends — actor, session, reason, before/after (D11161)",
  },
  args: {
    taskId: { type: 'positional', description: 'Task ID', required: true },
    limit: { type: 'string', description: 'Maximum entries (default 50)' },
  },
  async run({ args }) {
    await dispatchFromCli(
      'query',
      'tasks',
      'history',
      {
        taskId: String(args.taskId),
        ranking: true,
        ...(args.limit !== undefined ? { limit: Number.parseInt(String(args.limit), 10) } : {}),
      },
      { command: 'history' },
    );
  },
});

/** cleo history revert <entryId> — undo one ranking change as a new audited change (T12693) */
const revertCommand = defineCommand({
  meta: {
    name: 'revert',
    description:
      'Undo one ranking change (an entry id from `cleo history ranking`); refused if a field changed again since, unless --force',
  },
  args: {
    entryId: { type: 'positional', description: 'ranking_changed entry id', required: true },
    reason: { type: 'string', description: 'Why it is reverted (recorded)' },
    force: { type: 'boolean', description: 'Revert even though a field changed again since' },
  },
  async run({ args }) {
    await dispatchFromCli(
      'mutate',
      'tasks',
      'ranking.revert',
      {
        entryId: String(args.entryId),
        ...(args.reason !== undefined ? { reason: String(args.reason) } : {}),
        ...(args.force === true ? { force: true } : {}),
      },
      { command: 'history' },
    );
  },
});

/**
 * Root history command group — completion timeline and productivity analytics.
 *
 * Dispatches to `admin.log` (audit log) and `tasks.history` (work history).
 */
export const historyCommand = defineCommand({
  meta: { name: 'history', description: 'Completion timeline and productivity analytics' },
  subCommands: {
    log: logCommand,
    work: workCommand,
    ranking: rankingCommand,
    revert: revertCommand,
  },
  async run({ cmd, rawArgs }) {
    const firstArg = rawArgs?.find((a) => !a.startsWith('-'));
    if (firstArg && cmd.subCommands && firstArg in cmd.subCommands) return;
    await showUsage(cmd);
  },
});
