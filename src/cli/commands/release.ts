/**
 * CLI release command group.
 * @task T4467
 * @epic T4454
 */

import { Command } from 'commander';
import {
  createRelease,
  planRelease,
  shipRelease,
  listReleases,
  showRelease,
  getChangelog,
} from '../../core/release/index.js';
import { formatSuccess, formatError } from '../../core/output.js';
import { CleoError } from '../../core/errors.js';

/**
 * Register the release command group.
 * @task T4467
 */
export function registerReleaseCommand(program: Command): void {
  const release = program
    .command('release')
    .description('Release lifecycle management');

  release
    .command('create <version>')
    .description('Create a new release')
    .option('--tasks <ids>', 'Comma-separated task IDs')
    .option('--notes <notes>', 'Release notes')
    .option('--target-date <date>', 'Target release date')
    .action(async (version: string, opts: Record<string, unknown>) => {
      try {
        const result = await createRelease({
          version,
          tasks: opts['tasks'] ? (opts['tasks'] as string).split(',').map(s => s.trim()) : undefined,
          notes: opts['notes'] as string | undefined,
          targetDate: opts['targetDate'] as string | undefined,
        });
        console.log(formatSuccess({ release: result }));
      } catch (err) {
        if (err instanceof CleoError) {
          console.error(formatError(err));
          process.exit(err.code);
        }
        throw err;
      }
    });

  release
    .command('plan <version>')
    .description('Add or remove tasks from a release')
    .option('--tasks <ids>', 'Comma-separated task IDs to add')
    .option('--remove <ids>', 'Comma-separated task IDs to remove')
    .option('--notes <notes>', 'Update release notes')
    .action(async (version: string, opts: Record<string, unknown>) => {
      try {
        const result = await planRelease({
          version,
          tasks: opts['tasks'] ? (opts['tasks'] as string).split(',').map(s => s.trim()) : undefined,
          removeTasks: opts['remove'] ? (opts['remove'] as string).split(',').map(s => s.trim()) : undefined,
          notes: opts['notes'] as string | undefined,
        });
        console.log(formatSuccess({ release: result }));
      } catch (err) {
        if (err instanceof CleoError) {
          console.error(formatError(err));
          process.exit(err.code);
        }
        throw err;
      }
    });

  release
    .command('ship <version>')
    .description('Ship a release')
    .option('--bump-version', 'Update VERSION file')
    .option('--create-tag', 'Create git tag')
    .option('--push', 'Push to remote')
    .option('--dry-run', 'Preview without changes')
    .action(async (version: string, opts: Record<string, unknown>) => {
      try {
        const result = await shipRelease({
          version,
          bumpVersion: opts['bumpVersion'] as boolean | undefined,
          createTag: opts['createTag'] as boolean | undefined,
          push: opts['push'] as boolean | undefined,
          dryRun: opts['dryRun'] as boolean | undefined,
        });
        console.log(formatSuccess(result));
      } catch (err) {
        if (err instanceof CleoError) {
          console.error(formatError(err));
          process.exit(err.code);
        }
        throw err;
      }
    });

  release
    .command('list')
    .description('List all releases')
    .action(async () => {
      try {
        const result = await listReleases();
        console.log(formatSuccess({ releases: result, count: result.length }));
      } catch (err) {
        if (err instanceof CleoError) {
          console.error(formatError(err));
          process.exit(err.code);
        }
        throw err;
      }
    });

  release
    .command('show <version>')
    .description('Show release details')
    .action(async (version: string) => {
      try {
        const result = await showRelease(version);
        console.log(formatSuccess(result));
      } catch (err) {
        if (err instanceof CleoError) {
          console.error(formatError(err));
          process.exit(err.code);
        }
        throw err;
      }
    });

  release
    .command('changelog <version>')
    .description('Get changelog for a release')
    .action(async (version: string) => {
      try {
        const result = await getChangelog(version);
        console.log(formatSuccess({ changelog: result }));
      } catch (err) {
        if (err instanceof CleoError) {
          console.error(formatError(err));
          process.exit(err.code);
        }
        throw err;
      }
    });
}
