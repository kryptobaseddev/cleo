/**
 * CLI export command — export tasks to various formats.
 *
 * Thin dispatch wrapper routing to admin.export.  When no --output file is
 * given the raw content is written directly to stdout for piping.
 *
 * @task T4454, T5323, T5328
 */

import { defineCommand } from 'citty';
import { dispatchFromCli, dispatchRaw, handleRawError } from '../../dispatch/adapters/cli.js';

/**
 * `cleo export` — export tasks to CSV, TSV, JSON, or markdown format.
 */
export const exportCommand = defineCommand({
  meta: { name: 'export', description: 'Export tasks to CSV, TSV, JSON, or markdown format' },
  args: {
    'export-format': {
      type: 'string',
      description: 'Export format: json, csv, tsv, markdown',
      default: 'json',
    },
    output: {
      type: 'string',
      description: 'Output file path (stdout if omitted)',
    },
    status: {
      type: 'string',
      description: 'Filter by status (comma-separated)',
    },
    parent: {
      type: 'string',
      description: 'Filter by parent task',
    },
    phase: {
      type: 'string',
      description: 'Filter by phase',
    },
  },
  async run({ args }) {
    const hasOutput = !!args.output;

    if (hasOutput) {
      await dispatchFromCli(
        'query',
        'admin',
        'export',
        {
          format: args['export-format'],
          output: args.output,
          status: args.status as string | undefined,
          parent: args.parent as string | undefined,
          phase: args.phase as string | undefined,
        },
        { command: 'export' },
      );
    } else {
      // No output file — write content directly to stdout for piping.
      const response = await dispatchRaw('query', 'admin', 'export', {
        format: args['export-format'],
        status: args.status as string | undefined,
        parent: args.parent as string | undefined,
        phase: args.phase as string | undefined,
      });
      handleRawError(response, { command: 'export', operation: 'admin.export' });
      const data = response.data as { content?: string } | undefined;
      if (data?.content) {
        process.stdout.write(data.content);
        if (!data.content.endsWith('\n')) process.stdout.write('\n');
      }
    }
  },
});
