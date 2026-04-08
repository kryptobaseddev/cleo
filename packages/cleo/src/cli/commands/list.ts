/**
 * CLI list command.
 * @task T4460
 * @task T4668
 * @epic T4454
 */

import { ExitCode } from '@cleocode/contracts';
import { createPage } from '@cleocode/core';
import { dispatchRaw, handleRawError } from '../../dispatch/adapters/cli.js';
import type { ParamDef } from '../../dispatch/types.js';
import type { ShimCommand as Command } from '../commander-shim.js';
import { applyParamDefsToCommand, buildOperationHelp } from '../help-generator.js';
import { cliOutput } from '../renderers/index.js';

// ---------------------------------------------------------------------------
// ParamDef array for tasks.list
//
// The registry entry for tasks.list has a params array (already migrated in
// T4897 partial work), but it is reproduced here as ParamDef objects so that
// applyParamDefsToCommand can wire the CLI flags with short aliases and parse
// functions that the plain registry entry omits.
// ---------------------------------------------------------------------------
const LIST_PARAMS: readonly ParamDef[] = [
  {
    name: 'status',
    type: 'string',
    required: false,
    description: 'Filter by status',
    enum: ['pending', 'active', 'blocked', 'done', 'cancelled'] as const,
    cli: { flag: 'status' },
  },
  {
    name: 'priority',
    type: 'string',
    required: false,
    description: 'Filter by priority',
    enum: ['low', 'medium', 'high', 'critical'] as const,
    cli: { flag: 'priority' },
  },
  {
    name: 'type',
    type: 'string',
    required: false,
    description: 'Filter by task type',
    enum: ['epic', 'task', 'subtask', 'bug'] as const,
    cli: { flag: 'type' },
  },
  {
    name: 'parent',
    type: 'string',
    required: false,
    description: 'Filter by parent task ID',
    cli: { flag: 'parent' },
  },
  {
    name: 'phase',
    type: 'string',
    required: false,
    description: 'Filter by phase slug',
    cli: { flag: 'phase' },
  },
  {
    name: 'label',
    type: 'string',
    required: false,
    description: 'Filter by label',
    cli: { flag: 'label' },
  },
  {
    name: 'children',
    type: 'boolean',
    required: false,
    description: 'Show direct children only (requires --parent)',
    cli: { flag: 'children' },
  },
  {
    name: 'limit',
    type: 'number',
    required: false,
    description: 'Limit number of results',
    cli: { flag: 'limit', parse: parseInt as (val: string) => unknown },
  },
  {
    name: 'offset',
    type: 'number',
    required: false,
    description: 'Skip first N results',
    cli: { flag: 'offset', parse: parseInt as (val: string) => unknown },
  },
];

/**
 * Register the list command.
 * @task T4460
 * @task T4668
 */
export function registerListCommand(program: Command): void {
  const cmd = program
    .command('list')
    .alias('ls')
    .description(buildOperationHelp('tasks.list', 'List tasks with optional filters', LIST_PARAMS));

  // Auto-generate flag options from the ParamDef registry.  Replaces the
  // previous hand-written .option() chain and surfaces enum values (status,
  // priority, type) in --help output.
  applyParamDefsToCommand(cmd, LIST_PARAMS, 'tasks.list');

  cmd.action(async (opts: Record<string, unknown>) => {
    const limit = opts['limit'] as number | undefined;
    const offset = opts['offset'] as number | undefined;

    const params: Record<string, unknown> = {};
    if (opts['status'] !== undefined) params['status'] = opts['status'];
    if (opts['priority'] !== undefined) params['priority'] = opts['priority'];
    if (opts['type'] !== undefined) params['type'] = opts['type'];
    if (opts['parent'] !== undefined) params['parent'] = opts['parent'];
    if (opts['phase'] !== undefined) params['phase'] = opts['phase'];
    if (opts['label'] !== undefined) params['label'] = opts['label'];
    if (opts['children'] !== undefined) params['children'] = opts['children'];
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
  });
}
