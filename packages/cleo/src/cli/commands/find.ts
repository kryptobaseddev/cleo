/**
 * CLI find command
 * @task T4460
 * @task T4668
 * @task T487
 */
import { ExitCode } from '@cleocode/contracts';
import { createPage } from '@cleocode/core';
import { defineCommand } from 'citty';
import { dispatchRaw, handleRawError } from '../../dispatch/adapters/cli.js';
import { cliOutput } from '../renderers/index.js';
/** Native citty command for `cleo find [query]`. */
export const findCommand = defineCommand({
  meta: { name: 'find', description: 'Fuzzy search tasks by title/description' },
  args: {
    query: {
      type: 'positional',
      description: 'Search text (required unless --id is provided)',
      required: false,
    },
    id: { type: 'string', description: 'Search by ID prefix' },
    exact: { type: 'boolean', description: 'Exact title match' },
    status: {
      type: 'string',
      description: 'Filter by status (pending|active|blocked|done|cancelled)',
    },
    in: { type: 'string', description: 'Field to search in (title|description|notes|id)' },
    'include-archive': { type: 'boolean', description: 'Include archived tasks' },
    limit: { type: 'string', description: 'Max results (default: 20)' },
    offset: { type: 'string', description: 'Skip first N results' },
    fields: { type: 'string', description: 'Comma-separated additional fields to include' },
    verbose: { type: 'boolean', description: 'Include all task fields', alias: 'v' },
  },
  async run({ args }) {
    const limit = args.limit !== undefined ? Number.parseInt(args.limit, 10) : undefined;
    const offset = args.offset !== undefined ? Number.parseInt(args.offset, 10) : undefined;
    const params: Record<string, unknown> = {};
    if (args.query !== undefined) params['query'] = args.query;
    if (args.id !== undefined) params['id'] = args.id;
    if (args.exact !== undefined) params['exact'] = args.exact;
    if (args.status !== undefined) params['status'] = args.status;
    if (args.in !== undefined) params['field'] = args.in;
    if (args['include-archive'] !== undefined) params['includeArchive'] = args['include-archive'];
    if (limit !== undefined) params['limit'] = limit;
    if (offset !== undefined) params['offset'] = offset;
    if (args.fields !== undefined) params['fields'] = args.fields;
    if (args.verbose !== undefined) params['verbose'] = args.verbose;
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
  },
});
