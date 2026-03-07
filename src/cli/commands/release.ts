/**
 * CLI release command group.
 * @task T4467
 * @epic T4454
 */

import { Command } from 'commander';
import { dispatchFromCli } from '../../dispatch/adapters/cli.js';

export function registerReleaseCommand(program: Command): void {
  const release = program
    .command('release')
    .description('Release lifecycle management');

  release
    .command('add <version>')
    .alias('create')
    .description('Add a new release')
    .option('--tasks <ids>', 'Comma-separated task IDs')
    .option('--notes <notes>', 'Release notes')
    .option('--target-date <date>', 'Target release date')
    .action(async (version: string, opts: Record<string, unknown>) => {
      await dispatchFromCli('mutate', 'pipeline', 'release.prepare', {
        version,
        tasks: opts['tasks'] ? (opts['tasks'] as string).split(',').map(s => s.trim()) : undefined,
        notes: opts['notes'],
        targetDate: opts['targetDate'],
      }, { command: 'release' });
    });

  release
    .command('plan <version>')
    .description('Add or remove tasks from a release')
    .option('--tasks <ids>', 'Comma-separated task IDs to add')
    .option('--remove <ids>', 'Comma-separated task IDs to remove')
    .option('--notes <notes>', 'Update release notes')
    .action(async (version: string, opts: Record<string, unknown>) => {
      await dispatchFromCli('mutate', 'pipeline', 'release.prepare', {
        version, action: 'plan',
        tasks: opts['tasks'] ? (opts['tasks'] as string).split(',').map(s => s.trim()) : undefined,
        removeTasks: opts['remove'] ? (opts['remove'] as string).split(',').map(s => s.trim()) : undefined,
        notes: opts['notes'],
      }, { command: 'release' });
    });

  /**
   * Composite release: prepare → gates → changelog → commit → tag → push.
   * Requires --epic <id>. Use --dry-run to preview without writing anything.
   *
   * Flags:
   *   --epic <id>       Epic task ID referenced in commit message (required)
   *   --dry-run         Preview all actions without writing anything
   *   --no-push         Skip git push (commit and tag only)
   *   --no-bump         Skip version file bumping (default: bump if configured)
   *   --remote <r>      Override git remote (default: origin)
   */
  release
    .command('ship <version>')
    .description('Ship a release: gates → changelog → commit → tag → push')
    .requiredOption('--epic <id>', 'Epic task ID for commit message (e.g. T5576)')
    .option('--dry-run', 'Preview all actions without writing anything')
    .option('--no-push', 'Commit and tag but skip git push')
    .option('--no-bump', 'Skip version file bumping (default: bump if configured)')
    .option('--remote <remote>', 'Git remote to push to (default: origin)')
    .action(async (version: string, opts: Record<string, unknown>) => {
      await dispatchFromCli('mutate', 'pipeline', 'release.ship', {
        version,
        epicId: opts['epic'],
        dryRun: opts['dryRun'],
        push: opts['push'] !== false,
        bump: opts['bump'] !== false,
        remote: opts['remote'],
      }, { command: 'release' });
    });

  release
    .command('list')
    .description('List all releases')
    .action(async () => {
      await dispatchFromCli('query', 'pipeline', 'release.list', {}, { command: 'release' });
    });

  release
    .command('show <version>')
    .description('Show release details')
    .action(async (version: string) => {
      await dispatchFromCli('query', 'pipeline', 'release.show', { version }, { command: 'release' });
    });

  release
    .command('changelog <version>')
    .description('Generate changelog for a release')
    .action(async (version: string) => {
      await dispatchFromCli('mutate', 'pipeline', 'release.changelog', { version }, { command: 'release' });
    });

  release
    .command('cancel <version>')
    .description('Cancel and remove a release in draft or prepared state')
    .action(async (version: string) => {
      await dispatchFromCli('mutate', 'pipeline', 'release.cancel', { version }, { command: 'release' });
    });
}
