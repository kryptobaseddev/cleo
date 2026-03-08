/**
 * CLI command: cleo migrate claude-mem
 *
 * Migrates observations from the external claude-mem MCP plugin's SQLite
 * database (~/.claude-mem/claude-mem.db) into CLEO's native brain.db.
 *
 * @epic T5149
 * @task T5143
 */

import type { Command } from 'commander';
import { migrateClaudeMem } from '../../core/memory/claude-mem-migration.js';
import { getProjectRoot } from '../../core/paths.js';

/**
 * Register the `migrate claude-mem` command under a migrate parent command.
 *
 * Usage:
 *   cleo migrate claude-mem [--dry-run] [--source <path>] [--project <name>]
 */
export function registerMigrateClaudeMemCommand(program: Command): void {
  // Find or create the 'migrate' parent command
  let migrateCmd = program.commands.find((c) => c.name() === 'migrate');
  if (!migrateCmd) {
    migrateCmd = program.command('migrate').description('Data migration utilities');
  }

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

        if (result.dryRun) {
          console.log('[dry run] No changes made.');
        }

        console.log(
          `Imported ${result.observationsImported} observations, ` +
            `${result.learningsImported} learnings, ` +
            `${result.decisionsImported} decisions ` +
            `(${result.observationsSkipped} skipped)`,
        );

        if (result.errors.length > 0) {
          console.error(`\n${result.errors.length} error(s):`);
          for (const err of result.errors) {
            console.error(`  - ${err}`);
          }
          process.exit(1);
        }
      } catch (err: unknown) {
        console.error(`Error: ${(err as Error).message}`);
        process.exit(1);
      }
    });
}
