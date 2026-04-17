/**
 * CLI list command — list tasks with optional filters.
 *
 * Dispatches to `tasks.list` via dispatchRaw and renders the result
 * through cliOutput with pagination support.
 *
 * @task T4460
 * @task T4668
 * @epic T4454
 */

import { ExitCode } from '@cleocode/contracts';
import { createPage } from '@cleocode/core';
import { defineCommand } from 'citty';
import { dispatchRaw, handleRawError } from '../../dispatch/adapters/cli.js';
import { cliOutput } from '../renderers/index.js';

/**
 * cleo list — list tasks with optional filters.
 *
 * Alias `ls` is wired in index.ts.
 */
export const listCommand = defineCommand({
  meta: { name: 'list', description: 'List tasks with optional filters' },
  args: {
    status: {
      type: 'string',
      description: 'Filter by status (pending|active|blocked|done|cancelled)',
    },
    priority: {
      type: 'string',
      description: 'Filter by priority (low|medium|high|critical)',
    },
    type: {
      type: 'string',
      description: 'Filter by task type (epic|task|subtask|bug)',
    },
    parent: {
      type: 'string',
      description: 'Filter by parent task ID',
    },
    phase: {
      type: 'string',
      description: 'Filter by phase slug',
    },
    label: {
      type: 'string',
      description: 'Filter by label',
    },
    children: {
      type: 'boolean',
      description: 'Show direct children only (requires --parent)',
    },
    limit: {
      type: 'string',
      description: 'Limit number of results',
    },
    offset: {
      type: 'string',
      description: 'Skip first N results',
    },
  },
  async run({ args }) {
    const limit = args.limit !== undefined ? parseInt(args.limit, 10) : undefined;
    const offset = args.offset !== undefined ? parseInt(args.offset, 10) : undefined;

    const params: Record<string, unknown> = {};
    if (args.status !== undefined) params['status'] = args.status;
    if (args.priority !== undefined) params['priority'] = args.priority;
    if (args.type !== undefined) params['type'] = args.type;
    if (args.parent !== undefined) params['parent'] = args.parent;
    if (args.phase !== undefined) params['phase'] = args.phase;
    if (args.label !== undefined) params['label'] = args.label;
    if (args.children !== undefined) params['children'] = args.children;
    if (limit !== undefined) params['limit'] = limit;
    if (offset !== undefined) params['offset'] = offset;

    const response = await dispatchRaw('query', 'tasks', 'list', params);

    if (!response.success) {
      handleRawError(response, { command: 'list', operation: 'tasks.list' });
    }

    const rawData = response.data;
    const data =
      (Array.isArray(rawData)
        ? { tasks: rawData, total: rawData.length }
        : (rawData as Record<string, unknown>)) ?? {};
    const tasks = Array.isArray(data?.tasks) ? data.tasks : [];

    if (tasks.length === 0) {
      cliOutput(data, { command: 'list', message: 'No tasks found', operation: 'tasks.list' });
      process.exit(ExitCode.NO_DATA);
      return;
    }

    const filtered = (data?.filtered as number) ?? tasks.length;
    const page = response.page ?? createPage({ total: filtered, limit, offset });
    cliOutput(data, { command: 'list', operation: 'tasks.list', page });
  },
});
