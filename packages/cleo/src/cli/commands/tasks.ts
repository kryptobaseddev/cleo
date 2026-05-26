/**
 * CLI command group: `cleo tasks` — task CRUD via thin dispatch wrappers.
 *
 * All subcommands delegate to the `tasks` dispatch domain via
 * {@link dispatchFromCli}. No business logic lives here — only arg
 * extraction and dispatch routing (T1467 thin-wrapper migration).
 *
 * Subcommands:
 *   cleo tasks show <id>       — show full task details
 *   cleo tasks find <query>    — search tasks by keyword
 *   cleo tasks next            — auto-select highest-priority task
 *   cleo tasks current         — show currently active task
 *   cleo tasks plan            — composite planning view
 *   cleo tasks analyze         — leverage-sorted discovery
 *   cleo tasks slice <id>      — localized WorkGraph slice around a task
 *
 * Note: Mutation commands (add, update, complete, delete, etc.) retain their
 * top-level flat names (`cleo add`, `cleo complete`, etc.) per the original
 * CLI design. This module provides the `cleo tasks` namespace for query ops.
 *
 * @see packages/cleo/src/dispatch/domains/tasks.ts
 * @task T1467
 */

import { defineCommand } from 'citty';
import { dispatchFromCli } from '../../dispatch/adapters/cli.js';
import { isSubCommandDispatch } from '../lib/subcommand-guard.js';
import { cliOutput } from '../renderers/index.js';

// ---------------------------------------------------------------------------
// Query subcommands
// ---------------------------------------------------------------------------

const showSub = defineCommand({
  meta: { name: 'show', description: 'Show full task details' },
  args: {
    id: { type: 'positional', description: 'Task ID (e.g. T1234)', required: true },
    json: { type: 'boolean', description: 'Emit JSON output' },
  },
  async run({ args }) {
    await dispatchFromCli('query', 'tasks', 'show', { taskId: args.id }, { command: 'tasks show' });
  },
});

const findSub = defineCommand({
  meta: { name: 'find', description: 'Search tasks by keyword' },
  args: {
    query: { type: 'positional', description: 'Search query', required: false },
    status: { type: 'string', description: 'Filter by status' },
    parent: { type: 'string', description: 'Filter by parent ID' },
    limit: { type: 'string', description: 'Max results (default 20)' },
    json: { type: 'boolean', description: 'Emit JSON output' },
  },
  async run({ args }) {
    await dispatchFromCli(
      'query',
      'tasks',
      'find',
      {
        query: args.query ?? '',
        status: args.status,
        parentId: args.parent,
        limit: args.limit ? parseInt(args.limit as string, 10) : undefined,
      },
      { command: 'tasks find' },
    );
  },
});

const nextSub = defineCommand({
  meta: { name: 'next', description: 'Auto-select highest-priority next task' },
  args: {
    json: { type: 'boolean', description: 'Emit JSON output' },
  },
  async run() {
    await dispatchFromCli('query', 'tasks', 'next', {}, { command: 'tasks next' });
  },
});

const currentSub = defineCommand({
  meta: { name: 'current', description: 'Show currently active task' },
  args: {
    json: { type: 'boolean', description: 'Emit JSON output' },
  },
  async run() {
    await dispatchFromCli('query', 'tasks', 'current', {}, { command: 'tasks current' });
  },
});

const planSub = defineCommand({
  meta: { name: 'plan', description: 'Composite planning view: upcoming, blockers, dependencies' },
  args: {
    json: { type: 'boolean', description: 'Emit JSON output' },
  },
  async run() {
    await dispatchFromCli('query', 'tasks', 'plan', {}, { command: 'tasks plan' });
  },
});

const analyzeSub = defineCommand({
  meta: { name: 'analyze', description: 'Leverage-sorted task discovery' },
  args: {
    json: { type: 'boolean', description: 'Emit JSON output' },
  },
  async run() {
    await dispatchFromCli('query', 'tasks', 'analyze', {}, { command: 'tasks analyze' });
  },
});

const sliceSub = defineCommand({
  meta: {
    name: 'slice',
    description: 'Show a localized WorkGraph slice around a task',
  },
  args: {
    id: { type: 'positional', description: 'Task ID (e.g. T1234)', required: true },
    upstream: { type: 'boolean', description: 'Return upstream dependency slice only' },
    downstream: { type: 'boolean', description: 'Return downstream dependent slice only' },
    around: {
      type: 'boolean',
      description: 'Return upstream, downstream, and sibling context (default)',
    },
    depth: { type: 'string', description: 'Dependency traversal depth (default 1)' },
    radius: { type: 'string', description: 'Alias for --depth' },
    budget: { type: 'string', description: 'Maximum nodes per returned section' },
    'include-relates': {
      type: 'boolean',
      description: 'Include direct non-dependency related tasks',
    },
    json: { type: 'boolean', description: 'Emit JSON output' },
  },
  async run({ args }) {
    const direction = args.upstream ? 'upstream' : args.downstream ? 'downstream' : 'around';
    await dispatchFromCli(
      'query',
      'tasks',
      'slice',
      {
        taskId: args.id,
        direction,
        radius: args.radius ? parseInt(args.radius as string, 10) : undefined,
        depth: args.depth ? parseInt(args.depth as string, 10) : undefined,
        budget: args.budget ? parseInt(args.budget as string, 10) : undefined,
        includeRelates: Boolean(args['include-relates']),
      },
      { command: 'tasks slice' },
    );
  },
});

// ---------------------------------------------------------------------------
// Root command
// ---------------------------------------------------------------------------

/**
 * Root `cleo tasks` command — thin dispatch wrappers for task queries.
 *
 * @task T1467
 */
export const tasksCommand = defineCommand({
  meta: {
    name: 'tasks',
    description: 'Task query namespace: show, find, next, current, plan, analyze, slice',
  },
  subCommands: {
    show: showSub,
    find: findSub,
    next: nextSub,
    current: currentSub,
    plan: planSub,
    analyze: analyzeSub,
    slice: sliceSub,
  },
  async run({ cmd, rawArgs }) {
    if (isSubCommandDispatch(rawArgs, cmd.subCommands)) return;
    cliOutput(
      { subCommands: ['show', 'find', 'next', 'current', 'plan', 'analyze'] },
      {
        command: 'tasks',
        message: 'Usage: cleo tasks show|find|next|current|plan|analyze',
        operation: 'tasks',
      },
    );
  },
});
