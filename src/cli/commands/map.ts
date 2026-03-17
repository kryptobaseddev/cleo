/**
 * CLI map command - codebase analysis and mapping.
 * @epic cognitive-cleo
 */

import type { Command } from 'commander';
import { dispatchFromCli } from '../../dispatch/adapters/cli.js';

/**
 * Register the map command.
 */
export function registerMapCommand(program: Command): void {
  program
    .command('map')
    .description('Analyze codebase structure and return structured mapping')
    .option('--store', 'Store findings to brain.db')
    .option(
      '--focus <area>',
      'Focus on one area: stack, architecture, structure, conventions, testing, integrations, concerns',
    )
    .action(async (opts: Record<string, unknown>) => {
      const gateway = opts['store'] ? 'mutate' : 'query';
      const params: Record<string, unknown> = {};
      if (opts['focus']) params.focus = opts['focus'];

      await dispatchFromCli(gateway, 'admin', 'map', params, { command: 'map' });
    });
}
