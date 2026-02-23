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

  release
    .command('ship <version>')
    .description('Ship a release')
    .option('--bump-version', 'Update VERSION file')
    .option('--create-tag', 'Create git tag')
    .option('--push', 'Push to remote')
    .option('--dry-run', 'Preview without changes')
    .action(async (version: string, opts: Record<string, unknown>) => {
      await dispatchFromCli('mutate', 'pipeline', 'release.commit', {
        version,
        bumpVersion: opts['bumpVersion'],
        createTag: opts['createTag'],
        push: opts['push'],
        dryRun: opts['dryRun'],
      }, { command: 'release' });
    });

  release
    .command('list')
    .description('List all releases')
    .action(async () => {
      await dispatchFromCli('query', 'pipeline', 'release.changelog', {
        action: 'list',
      }, { command: 'release' });
    });

  release
    .command('show <version>')
    .description('Show release details')
    .action(async (version: string) => {
      await dispatchFromCli('query', 'pipeline', 'release.changelog', {
        version, action: 'show',
      }, { command: 'release' });
    });

  release
    .command('changelog <version>')
    .description('Get changelog for a release')
    .action(async (version: string) => {
      await dispatchFromCli('query', 'pipeline', 'release.changelog', {
        version,
      }, { command: 'release' });
    });
}
