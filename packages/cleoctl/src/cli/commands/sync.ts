/**
 * CLI sync command - bidirectional sync with Claude Code TodoWrite.
 * Ported from scripts/sync.sh
 * @task T4551, T5326
 * @epic T4545, T5323
 */

import type { Command } from 'commander';
import { dispatchFromCli } from '../../dispatch/adapters/cli.js';

/**
 * Register the sync command.
 * @task T4551, T5326
 */
export function registerSyncCommand(program: Command): void {
  const syncCmd = program
    .command('sync')
    .description('Bidirectional sync with Claude Code TodoWrite');

  // T5326: Migrated to dispatch
  syncCmd
    .command('status')
    .description('Show current sync state')
    .action(async () => {
      await dispatchFromCli('query', 'tools', 'todowrite.status', {}, { command: 'sync' });
    });

  // T5326: Migrated to dispatch
  syncCmd
    .command('clear')
    .description('Clear sync state without merging')
    .option('--dry-run', 'Preview what would be cleared')
    .action(async (opts: Record<string, unknown>) => {
      await dispatchFromCli(
        'mutate',
        'tools',
        'todowrite.clear',
        { dryRun: opts['dryRun'] },
        { command: 'sync' },
      );
    });

  // Inject and extract are registered separately as standalone commands
  // (extract.ts and inject.ts), but we add aliases here for backward compat
  syncCmd
    .command('inject')
    .description('Prepare tasks for TodoWrite (delegates to inject command)')
    .allowUnknownOption(true)
    .action(() => {
      console.log('Use "cleo inject" directly for TodoWrite injection');
    });

  syncCmd
    .command('extract')
    .description('Merge TodoWrite state back (delegates to extract command)')
    .allowUnknownOption(true)
    .action(() => {
      console.log('Use "cleo extract <file>" directly for TodoWrite extraction');
    });
}
