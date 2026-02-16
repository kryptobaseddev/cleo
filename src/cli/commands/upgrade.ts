/**
 * CLI upgrade command - unified project maintenance.
 * Schema migration, structural repair, doc updates.
 * @task T4454
 */

import { Command } from 'commander';
import { formatSuccess, formatError } from '../../core/output.js';
import { CleoError } from '../../core/errors.js';
import { ExitCode } from '../../types/exit-codes.js';
import { readJson, saveJson, computeChecksum } from '../../store/json.js';
import { getTodoPath, getBackupDir } from '../../core/paths.js';
import { createBackup } from '../../store/backup.js';
import type { TodoFile } from '../../types/task.js';

interface UpgradeAction {
  action: string;
  status: 'applied' | 'skipped' | 'preview';
  details: string;
}

export function registerUpgradeCommand(program: Command): void {
  program
    .command('upgrade')
    .description('Unified project maintenance (schema migration, structural repair)')
    .option('--status', 'Show what needs updating without making changes')
    .option('--dry-run', 'Preview changes without applying')
    .option('--force', 'Skip confirmation prompts')
    .action(async (opts: Record<string, unknown>) => {
      try {
        const todoPath = getTodoPath();
        const data = await readJson<TodoFile>(todoPath);
        if (!data) {
          throw new CleoError(ExitCode.NOT_FOUND, 'No todo.json found. Run: cleo init');
        }

        const actions: UpgradeAction[] = [];
        const isDryRun = !!opts['dryRun'] || !!opts['status'];

        // 1. Check schema version
        const schemaVersion = data._meta?.schemaVersion;
        const currentVersion = '2.10.0';
        if (!schemaVersion) {
          if (isDryRun) {
            actions.push({
              action: 'add_schema_version',
              status: 'preview',
              details: `Would set _meta.schemaVersion to ${currentVersion}`,
            });
          } else {
            data._meta = data._meta ?? {} as TodoFile['_meta'];
            data._meta.schemaVersion = currentVersion;
            actions.push({
              action: 'add_schema_version',
              status: 'applied',
              details: `Set _meta.schemaVersion to ${currentVersion}`,
            });
          }
        } else if (schemaVersion !== currentVersion) {
          actions.push({
            action: 'schema_version_check',
            status: isDryRun ? 'preview' : 'skipped',
            details: `Schema version ${schemaVersion} differs from current ${currentVersion}`,
          });
        } else {
          actions.push({
            action: 'schema_version_check',
            status: 'skipped',
            details: 'Schema version up to date',
          });
        }

        // 2. Check and fix checksum
        const storedChecksum = data._meta?.checksum;
        const computedChecksum = computeChecksum(data.tasks);
        if (storedChecksum !== computedChecksum) {
          if (isDryRun) {
            actions.push({
              action: 'fix_checksum',
              status: 'preview',
              details: `Would update checksum from ${storedChecksum ?? 'none'} to ${computedChecksum}`,
            });
          } else {
            data._meta.checksum = computedChecksum;
            actions.push({
              action: 'fix_checksum',
              status: 'applied',
              details: `Updated checksum to ${computedChecksum}`,
            });
          }
        }

        // 3. Check done tasks missing completedAt
        const doneMissingDate = data.tasks.filter((t) => t.status === 'done' && !t.completedAt);
        if (doneMissingDate.length > 0) {
          if (isDryRun) {
            actions.push({
              action: 'fix_completed_at',
              status: 'preview',
              details: `Would set completedAt for ${doneMissingDate.length} done task(s)`,
            });
          } else {
            const now = new Date().toISOString();
            for (const t of doneMissingDate) {
              t.completedAt = now;
            }
            actions.push({
              action: 'fix_completed_at',
              status: 'applied',
              details: `Set completedAt for ${doneMissingDate.length} done task(s)`,
            });
          }
        }

        // 4. Check missing size fields
        const missingSizes = data.tasks.filter((t) => !t.size);
        if (missingSizes.length > 0) {
          if (isDryRun) {
            actions.push({
              action: 'fix_missing_sizes',
              status: 'preview',
              details: `Would set size='medium' for ${missingSizes.length} task(s)`,
            });
          } else {
            for (const t of missingSizes) {
              t.size = 'medium';
            }
            actions.push({
              action: 'fix_missing_sizes',
              status: 'applied',
              details: `Set size='medium' for ${missingSizes.length} task(s)`,
            });
          }
        }

        // Save if changes were made
        const applied = actions.filter((a) => a.status === 'applied');
        if (applied.length > 0 && !isDryRun) {
          // Backup first
          try {
            await createBackup(todoPath, getBackupDir());
          } catch {
            // Non-fatal
          }

          data._meta.checksum = computeChecksum(data.tasks);
          data.lastUpdated = new Date().toISOString();
          await saveJson(todoPath, data, { backupDir: getBackupDir() });
        }

        const needsWork = actions.some((a) => a.status === 'applied' || a.status === 'preview');

        console.log(formatSuccess({
          upToDate: !needsWork,
          dryRun: isDryRun,
          actions,
          applied: applied.length,
        }));

        if (applied.length > 0) {
          process.exit(2); // exit 2 = changes applied (per bash convention)
        }
      } catch (err) {
        if (err instanceof CleoError) {
          console.error(formatError(err));
          process.exit(err.code);
        }
        throw err;
      }
    });
}
