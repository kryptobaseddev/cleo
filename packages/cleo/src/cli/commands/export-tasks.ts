/**
 * CLI export-tasks command - export tasks to portable package for cross-project transfer.
 * Thin dispatch wrapper routing to admin.export.tasks.
 *
 * @task T4551, T5323, T5328
 * @epic T4545
 */

import { defineCommand } from 'citty';
import { dispatchFromCli, dispatchRaw, handleRawError } from '../../dispatch/adapters/cli.js';

/**
 * Export tasks to a portable `.cleo-export.json` package for cross-project transfer.
 *
 * Dispatches to `admin.export` with `scope: 'tasks'`. When `--output` or `--dry-run`
 * is provided the result goes through the standard LAFS formatter; otherwise the raw
 * JSON content is written directly to stdout for piping.
 */
export const exportTasksCommand = defineCommand({
  meta: {
    name: 'export-tasks',
    description: 'Export tasks to portable .cleo-export.json package for cross-project transfer',
  },
  args: {
    taskIds: {
      type: 'positional',
      description: 'Task IDs to export (space-separated; omit to export all)',
      required: false,
    },
    output: {
      type: 'string',
      description: 'Output file path (stdout if omitted)',
      alias: 'o',
    },
    subtree: {
      type: 'boolean',
      description: 'Include all descendants of specified task(s)',
      default: false,
    },
    filter: {
      type: 'string',
      description: 'Filter tasks by criteria (key=value)',
    },
    'include-deps': {
      type: 'boolean',
      description: 'Auto-include task dependencies',
      default: false,
    },
    'dry-run': {
      type: 'boolean',
      description: 'Preview selection without creating export file',
      default: false,
    },
  },
  async run({ args }) {
    const hasOutput = !!args.output;
    const dryRun = args['dry-run'];

    const params = {
      taskIds: args.taskIds ? [args.taskIds] : undefined,
      output: args.output as string | undefined,
      subtree: args.subtree,
      filter: args.filter as string | undefined,
      includeDeps: args['include-deps'],
      dryRun,
      scope: 'tasks',
    };

    if (hasOutput || dryRun) {
      await dispatchFromCli('query', 'admin', 'export', params, { command: 'export-tasks' });
    } else {
      // No output file — write content directly to stdout for piping
      const response = await dispatchRaw('query', 'admin', 'export', params);
      handleRawError(response, { command: 'export-tasks', operation: 'admin.export' });
      const data = response.data as { content?: string } | undefined;
      if (data?.content) {
        process.stdout.write(data.content);
        if (!data.content.endsWith('\n')) process.stdout.write('\n');
      }
    }
  },
});
