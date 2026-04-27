/**
 * CLI list command — list tasks with optional filters.
 *
 * Dispatches to `tasks.list` via dispatchRaw and renders the result
 * through cliOutput with pagination support.
 *
 * Args are derived from the registry via `paramsToCittyArgs` so that the
 * CLI surface stays in sync with `tasks.list` params[] (T864 SSoT).
 * CLI-only compatibility aliases are layered locally after registry arg
 * derivation so dispatch still receives canonical task params.
 *
 * @task T4460
 * @task T4668
 * @task T864
 * @epic T4454
 */

import { ExitCode } from '@cleocode/contracts';
import { createPage } from '@cleocode/core';
import { defineCommand } from 'citty';
import { dispatchRaw, handleRawError } from '../../dispatch/adapters/cli.js';
import { getOperationParams, paramsToCittyArgs } from '../lib/registry-args.js';
import { cliOutput } from '../renderers/index.js';

const listArgs = {
  ...paramsToCittyArgs(getOperationParams('query', 'tasks', 'list')),
  'parent-id': {
    type: 'string',
    description: 'Alias for --parent (legacy parentId compatibility)',
  },
} as const;

/**
 * cleo list — list tasks with optional filters.
 *
 * Alias `ls` is wired in index.ts.
 */
export const listCommand = defineCommand({
  meta: { name: 'list', description: 'List tasks with optional filters' },
  args: listArgs,
  async run({ args }) {
    const limit = args['limit'] !== undefined ? parseInt(args['limit'] as string, 10) : undefined;
    const offset =
      args['offset'] !== undefined ? parseInt(args['offset'] as string, 10) : undefined;

    const params: Record<string, unknown> = {};
    if (args['status'] !== undefined) params['status'] = args['status'];
    if (args['priority'] !== undefined) params['priority'] = args['priority'];
    if (args['type'] !== undefined) params['type'] = args['type'];
    if (args['parent'] !== undefined) params['parent'] = args['parent'];
    if (args['parent-id'] !== undefined) params['parent'] = params['parent'] ?? args['parent-id'];
    if (args['phase'] !== undefined) params['phase'] = args['phase'];
    if (args['label'] !== undefined) params['label'] = args['label'];
    if (args['children'] !== undefined) params['children'] = args['children'];
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
