/**
 * CLI export command - export tasks to various formats.
 * Thin dispatch wrapper routing to admin.export.
 *
 * @task T4454, T5323, T5328
 */

import type { Command } from 'commander';
import { dispatchFromCli, dispatchRaw, handleRawError } from '../../dispatch/adapters/cli.js';

export function registerExportCommand(program: Command): void {
  program
    .command('export')
    .description('Export tasks to CSV, TSV, JSON, markdown, or TodoWrite format')
    .option(
      '--export-format <format>',
      'Export format: json, csv, tsv, markdown, todowrite',
      'json',
    )
    .option('--output <file>', 'Output file path (stdout if omitted)')
    .option('--status <statuses>', 'Filter by status (comma-separated)')
    .option('--parent <id>', 'Filter by parent task')
    .option('--phase <phase>', 'Filter by phase')
    .action(async (opts: Record<string, unknown>) => {
      const hasOutput = !!opts['output'];

      if (hasOutput) {
        await dispatchFromCli(
          'query',
          'admin',
          'export',
          {
            format: opts['exportFormat'],
            output: opts['output'],
            status: opts['status'],
            parent: opts['parent'],
            phase: opts['phase'],
          },
          { command: 'export' },
        );
      } else {
        // No output file — write content directly to stdout for piping
        const response = await dispatchRaw('query', 'admin', 'export', {
          format: opts['exportFormat'],
          status: opts['status'],
          parent: opts['parent'],
          phase: opts['phase'],
        });
        handleRawError(response, { command: 'export', operation: 'admin.export' });
        const data = response.data as { content?: string } | undefined;
        if (data?.content) {
          process.stdout.write(data.content);
          if (!data.content.endsWith('\n')) process.stdout.write('\n');
        }
      }
    });
}
