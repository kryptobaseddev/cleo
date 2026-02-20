/**
 * CLI phase command with subcommands.
 * @task T4464
 * @epic T4454
 */

import { Command } from 'commander';
import {
  listPhases,
  showPhase,
  setPhase,
  startPhase,
  completePhase,
  advancePhase,
  renamePhase,
  deletePhase,
} from '../../core/phases/index.js';
import { formatError } from '../../core/output.js';
import { cliOutput } from '../renderers/index.js';
import { CleoError } from '../../core/errors.js';

/**
 * Register the phase command group.
 * @task T4464
 */
export function registerPhaseCommand(program: Command): void {
  const phase = program
    .command('phase')
    .description('Project-level phase lifecycle management');

  phase
    .command('show [slug]')
    .description('Show phase details (current phase if no slug given)')
    .action(async (slug?: string) => {
      try {
        const result = await showPhase(slug);
        cliOutput(result, { command: 'phase' });
      } catch (err) {
        if (err instanceof CleoError) {
          console.error(formatError(err));
          process.exit(err.code);
        }
        throw err;
      }
    });

  phase
    .command('list')
    .description('List all phases with status')
    .action(async () => {
      try {
        const result = await listPhases();
        cliOutput(result, { command: 'phase' });
      } catch (err) {
        if (err instanceof CleoError) {
          console.error(formatError(err));
          process.exit(err.code);
        }
        throw err;
      }
    });

  phase
    .command('set <slug>')
    .description('Set current phase')
    .option('--rollback', 'Allow backward phase movement')
    .option('--force', 'Skip confirmation prompt')
    .option('--dry-run', 'Preview changes without modifying files')
    .action(async (slug: string, opts: Record<string, unknown>) => {
      try {
        const result = await setPhase({
          slug,
          rollback: opts['rollback'] as boolean | undefined,
          force: opts['force'] as boolean | undefined,
          dryRun: opts['dryRun'] as boolean | undefined,
        });
        cliOutput(result, { command: 'phase' });
      } catch (err) {
        if (err instanceof CleoError) {
          console.error(formatError(err));
          process.exit(err.code);
        }
        throw err;
      }
    });

  phase
    .command('start <slug>')
    .description('Start a phase (pending -> active)')
    .action(async (slug: string) => {
      try {
        const result = await startPhase(slug);
        cliOutput(result, { command: 'phase' });
      } catch (err) {
        if (err instanceof CleoError) {
          console.error(formatError(err));
          process.exit(err.code);
        }
        throw err;
      }
    });

  phase
    .command('complete <slug>')
    .description('Complete a phase (active -> completed)')
    .action(async (slug: string) => {
      try {
        const result = await completePhase(slug);
        cliOutput(result, { command: 'phase' });
      } catch (err) {
        if (err instanceof CleoError) {
          console.error(formatError(err));
          process.exit(err.code);
        }
        throw err;
      }
    });

  phase
    .command('advance')
    .description('Complete current phase and start next')
    .option('-f, --force', 'Skip validation and interactive prompt')
    .action(async (opts: Record<string, unknown>) => {
      try {
        const result = await advancePhase(opts['force'] as boolean | undefined);
        cliOutput(result, { command: 'phase' });
      } catch (err) {
        if (err instanceof CleoError) {
          console.error(formatError(err));
          process.exit(err.code);
        }
        throw err;
      }
    });

  phase
    .command('rename <oldName> <newName>')
    .description('Rename a phase and update all task references')
    .action(async (oldName: string, newName: string) => {
      try {
        const result = await renamePhase(oldName, newName);
        cliOutput(result, { command: 'phase' });
      } catch (err) {
        if (err instanceof CleoError) {
          console.error(formatError(err));
          process.exit(err.code);
        }
        throw err;
      }
    });

  phase
    .command('delete <slug>')
    .description('Delete a phase with task reassignment protection')
    .option('--reassign-to <phase>', 'Reassign tasks to another phase')
    .option('--force', 'Required safety flag')
    .action(async (slug: string, opts: Record<string, unknown>) => {
      try {
        const result = await deletePhase(slug, {
          reassignTo: opts['reassignTo'] as string | undefined,
          force: opts['force'] as boolean | undefined,
        });
        cliOutput(result, { command: 'phase' });
      } catch (err) {
        if (err instanceof CleoError) {
          console.error(formatError(err));
          process.exit(err.code);
        }
        throw err;
      }
    });
}
