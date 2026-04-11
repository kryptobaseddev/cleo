/**
 * CLI command: cleo migrate claude-mem / cleo migrate storage
 *
 * Migrates observations from the external claude-mem plugin's SQLite
 * database (~/.claude-mem/claude-mem.db) into CLEO's native brain.db.
 *
 * Also registers `cleo migrate storage` which dispatches to the admin.migrate
 * operation for internal CLEO storage/schema migrations.
 *
 * @epic T5149
 * @task T5143
 * @task T480 — add `migrate storage` subcommand dispatching to mutate admin migrate.
 */

import { getProjectRoot, migrateClaudeMem } from '@cleocode/core/internal';
import { dispatchFromCli } from '../../dispatch/adapters/cli.js';
import type { ShimCommand as Command } from '../commander-shim.js';
import { cliError, cliOutput } from '../renderers/index.js';

/**
 * Register the `migrate` parent command with its subcommands.
 *
 * Subcommands:
 *   cleo migrate claude-mem [--dry-run] [--source <path>] [--project <name>]
 *   cleo migrate storage    [--target <version>] [--dry-run]
 */
export function registerMigrateClaudeMemCommand(program: Command): void {
  // Find or create the 'migrate' parent command
  let migrateCmd = program.commands.find((c) => c.name() === 'migrate');
  if (!migrateCmd) {
    migrateCmd = program.command('migrate').description('Data migration utilities');
  }

  // cleo migrate storage — wraps mutate admin migrate
  migrateCmd
    .command('storage')
    .description('Run CLEO internal storage and schema migrations')
    .option('--target <version>', 'Target schema version to migrate to')
    .option('--dry-run', 'Preview migration steps without making changes')
    .action(async (opts: Record<string, unknown>) => {
      await dispatchFromCli(
        'mutate',
        'admin',
        'migrate',
        {
          target: opts['target'] as string | undefined,
          dryRun: opts['dryRun'] === true,
        },
        { command: 'migrate storage', operation: 'admin.migrate' },
      );
    });

  migrateCmd
    .command('claude-mem')
    .description('Import observations from claude-mem into brain.db')
    .option('--dry-run', 'Show what would be imported without making changes')
    .option('--source <path>', 'Path to claude-mem.db (default: ~/.claude-mem/claude-mem.db)')
    .option('--project <name>', 'Project tag for imported entries')
    .option('--batch-size <n>', 'Rows per transaction batch (default: 100)', parseInt)
    .action(async (opts: Record<string, unknown>) => {
      const root = getProjectRoot();

      try {
        const result = await migrateClaudeMem(root, {
          sourcePath: opts['source'] as string | undefined,
          project: opts['project'] as string | undefined,
          dryRun: !!opts['dryRun'],
          batchSize: (opts['batchSize'] as number) || undefined,
        });

        cliOutput(
          {
            dryRun: result.dryRun,
            observationsImported: result.observationsImported,
            learningsImported: result.learningsImported,
            decisionsImported: result.decisionsImported,
            observationsSkipped: result.observationsSkipped,
            errors: result.errors,
          },
          { command: 'migrate-claude-mem', operation: 'migrate.claude-mem' },
        );

        if (result.errors.length > 0) {
          process.exitCode = 1;
        }
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        cliError(message, 'E_MIGRATION_FAILED', undefined, {
          operation: 'migrate.claude-mem',
        });
        process.exitCode = 1;
      }
    });
}
