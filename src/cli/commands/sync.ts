/**
 * CLI sync command - bidirectional sync with Claude Code TodoWrite.
 * Ported from scripts/sync.sh
 * @task T4551
 * @epic T4545
 */

// TODO T4894: admin.sync exists in registry but sync.ts has different subcommand structure\n// (status/clear/inject/extract aliases). Migrate when handler supports status subcommand.
import { Command } from 'commander';
import { rm, rmdir, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { formatError } from '../../core/output.js';
import { cliOutput } from '../renderers/index.js';
import { CleoError } from '../../core/errors.js';
import { getCleoDir } from '../../core/paths.js';
import { readJson } from '../../store/json.js';

/** Sync session state stored in .cleo/sync/todowrite-session.json. */
interface SyncSessionState {
  session_id: string;
  injected_at: string;
  injectedPhase?: string;
  injected_tasks: string[];
  task_metadata?: Record<string, { phase?: string }>;
}

/**
 * Register the sync command.
 * @task T4551
 */
export function registerSyncCommand(program: Command): void {
  const syncCmd = program
    .command('sync')
    .description('Bidirectional sync with Claude Code TodoWrite');

  // Status subcommand
  syncCmd
    .command('status')
    .description('Show current sync state')
    .action(async () => {
      try {
        const cleoDir = getCleoDir();
        const stateFile = join(cleoDir, 'sync', 'todowrite-session.json');
        const sessionState = await readJson<SyncSessionState>(stateFile);

        if (!sessionState) {
          cliOutput({
            active: false,
            stateFile,
          }, { command: 'sync', message: 'No active sync session' });
          return;
        }

        // Build phase distribution from metadata
        let phases: Array<{ phase: string; count: number }> | null = null;
        if (sessionState.task_metadata) {
          const phaseMap = new Map<string, number>();
          for (const meta of Object.values(sessionState.task_metadata)) {
            const phase = meta.phase ?? 'unknown';
            phaseMap.set(phase, (phaseMap.get(phase) ?? 0) + 1);
          }
          phases = [...phaseMap.entries()].map(([phase, count]) => ({ phase, count }));
        }

        cliOutput({
          active: true,
          sessionId: sessionState.session_id,
          injectedAt: sessionState.injected_at,
          injectedPhase: sessionState.injectedPhase ?? 'none',
          taskCount: sessionState.injected_tasks.length,
          taskIds: sessionState.injected_tasks,
          phases,
          stateFile,
        }, { command: 'sync' });
      } catch (err) {
        if (err instanceof CleoError) {
          console.error(formatError(err));
          process.exit(err.code);
        }
        throw err;
      }
    });

  // Clear subcommand
  syncCmd
    .command('clear')
    .description('Clear sync state without merging')
    .option('--dry-run', 'Preview what would be cleared')
    .action(async (opts: Record<string, unknown>) => {
      try {
        const cleoDir = getCleoDir();
        const syncDir = join(cleoDir, 'sync');
        const stateFile = join(syncDir, 'todowrite-session.json');

        let exists = false;
        try {
          await stat(stateFile);
          exists = true;
        } catch {
          // File doesn't exist
        }

        if (!exists) {
          cliOutput(
            { noChange: true },
            { command: 'sync', message: 'No sync state to clear' },
          );
          return;
        }

        if (opts['dryRun']) {
          cliOutput({
            dryRun: true,
            wouldDelete: { stateFile, syncDirectory: syncDir },
          }, { command: 'sync', message: 'Would clear sync state' });
          return;
        }

        await rm(stateFile, { force: true });
        // Clean up empty sync directory
        try { await rmdir(syncDir); } catch { /* not empty or doesn't exist */ }

        cliOutput(
          { cleared: { stateFile } },
          { command: 'sync', message: 'Sync state cleared' },
        );
      } catch (err) {
        if (err instanceof CleoError) {
          console.error(formatError(err));
          process.exit(err.code);
        }
        throw err;
      }
    });

  // Inject and extract are registered separately as standalone commands
  // (extract.ts and inject.ts), but we add aliases here for backward compat
  syncCmd
    .command('inject')
    .description('Prepare tasks for TodoWrite (delegates to inject command)')
    .allowUnknownOption(true)
    .action(() => {
      cliOutput(
        { delegated: true },
        { command: 'sync', message: 'Use "cleo inject" directly for TodoWrite injection' },
      );
    });

  syncCmd
    .command('extract')
    .description('Merge TodoWrite state back (delegates to extract command)')
    .allowUnknownOption(true)
    .action(() => {
      cliOutput(
        { delegated: true },
        { command: 'sync', message: 'Use "cleo extract <file>" directly for TodoWrite extraction' },
      );
    });
}
