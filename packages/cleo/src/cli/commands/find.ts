/**
 * CLI find command.
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
// ParamDef array for tasks.find
//
// The registry entry for tasks.find lacks a params array (T4897 migration
// pending).  This local definition is the CLI-visible source of truth until
// the upstream migration completes.
// ---------------------------------------------------------------------------
const FIND_PARAMS: readonly ParamDef[] = [
  {
    name: 'query',
    type: 'string',
    required: false,
    description: 'Fuzzy search query (title/description)',
    cli: { positional: true },
  },
  {
    name: 'id',
    type: 'string',
    required: false,
    description: 'Search by ID prefix',
    cli: { flag: 'id' },
  },
  {
    name: 'exact',
    type: 'boolean',
    required: false,
    description: 'Exact title match',
    cli: { flag: 'exact' },
  },
  {
    name: 'status',
    type: 'string',
    required: false,
    description: 'Filter by status',
    enum: ['pending', 'active', 'blocked', 'done', 'cancelled'] as const,
    cli: { flag: 'status' },
  },
  {
    name: 'field',
    type: 'string',
    required: false,
    description: 'Field to search in (title, description, etc.)',
    cli: { flag: 'in' },
  },
  {
    name: 'includeArchive',
    type: 'boolean',
    required: false,
    description: 'Include archived tasks',
    cli: { flag: 'include-archive' },
  },
  {
    name: 'limit',
    type: 'number',
    required: false,
    description: 'Max results (default: 20)',
    cli: { flag: 'limit', parse: parseInt as (val: string) => unknown },
  },
  {
    name: 'offset',
    type: 'number',
    required: false,
    description: 'Skip first N results',
    cli: { flag: 'offset', parse: parseInt as (val: string) => unknown },
  },
  {
    name: 'fields',
    type: 'string',
    required: false,
    description:
      'Comma-separated additional fields to include (e.g. labels,acceptance,notes,description)',
    cli: { flag: 'fields' },
  },
  {
    name: 'verbose',
    type: 'boolean',
    required: false,
    description: 'Include all task fields (same as cleo list output)',
    cli: { flag: 'verbose', short: '-v' },
  },
];

/**
 * Register the find command.
 * @task T4460
 * @task T4668
 */
export function registerFindCommand(program: Command): void {
  const cmd = program
    .command('find')
    .description(
      buildOperationHelp('tasks.find', 'Fuzzy search tasks by title/description', FIND_PARAMS),
    );

  // Auto-generate [query] positional arg and flag options from the ParamDef
  // registry.  Replaces the previous hand-written .option() chain and surfaces
  // enum values (e.g. status) in --help output.
  applyParamDefsToCommand(cmd, FIND_PARAMS, 'tasks.find');

  cmd.action(async (query: string | undefined, opts: Record<string, unknown>) => {
    const limit = opts['limit'] as number | undefined;
    const offset = opts['offset'] as number | undefined;

    const params: Record<string, unknown> = {};
    if (query !== undefined) params['query'] = query;
    if (opts['id'] !== undefined) params['id'] = opts['id'];
    if (opts['exact'] !== undefined) params['exact'] = opts['exact'];
    if (opts['status'] !== undefined) params['status'] = opts['status'];
    if (opts['in'] !== undefined) params['field'] = opts['in'];
    if (opts['includeArchive'] !== undefined) params['includeArchive'] = opts['includeArchive'];
    if (limit !== undefined) params['limit'] = limit;
    if (offset !== undefined) params['offset'] = offset;
    if (opts['fields'] !== undefined) params['fields'] = opts['fields'];
    if (opts['verbose'] !== undefined) params['verbose'] = opts['verbose'];

    const response = await dispatchRaw('query', 'tasks', 'find', params);

    if (!response.success) {
      handleRawError(response, { command: 'find', operation: 'tasks.find' });
    }

    const rawData = response.data;
    const data =
      (Array.isArray(rawData)
        ? { results: rawData, total: rawData.length }
        : (rawData as Record<string, unknown>)) ?? {};
    const results = Array.isArray(data?.results) ? data.results : [];

    if (results.length === 0) {
      cliOutput(data, {
        command: 'find',
        message: 'No matching tasks found',
        operation: 'tasks.find',
      });
      process.exit(ExitCode.NO_DATA);
      return;
    }

    const total = (data?.total as number) ?? results.length;
    const page = createPage({ total, limit, offset });
    cliOutput(data, { command: 'find', operation: 'tasks.find', page });
  });
}
