/**
 * CLI phase command with subcommands.
 * @task T4464, T5326
 * @epic T4454, T5323
 */

import type { Command } from 'commander';
import { dispatchFromCli } from '../../dispatch/adapters/cli.js';

/**
 * Register the phase command group.
 * @task T4464, T5326
 */
export function registerPhaseCommand(program: Command): void {
  const phase = program.command('phase').description('Project-level phase lifecycle management');

  // T5326: Migrated to dispatch
  phase
    .command('show [slug]')
    .description('Show phase details (current phase if no slug given)')
    .action(async (slug?: string) => {
      const params = slug ? { phaseId: slug } : {};
      await dispatchFromCli('query', 'pipeline', 'phase.show', params, { command: 'phase' });
    });

  // T5326: Migrated to dispatch
  phase
    .command('list')
    .description('List all phases with status')
    .action(async () => {
      await dispatchFromCli('query', 'pipeline', 'phase.list', {}, { command: 'phase' });
    });

  // T5326: Migrated to dispatch
  phase
    .command('set <slug>')
    .description('Set current phase')
    .option('--rollback', 'Allow backward phase movement')
    .option('--force', 'Skip confirmation prompt')
    .option('--dry-run', 'Preview changes without modifying files')
    .action(async (slug: string, opts: Record<string, unknown>) => {
      await dispatchFromCli(
        'mutate',
        'pipeline',
        'phase.set',
        {
          phaseId: slug,
          rollback: opts['rollback'],
          force: opts['force'],
          dryRun: opts['dryRun'],
        },
        { command: 'phase' },
      );
    });

  // T5326: Migrated to dispatch
  phase
    .command('start <slug>')
    .description('Start a phase (pending -> active)')
    .action(async (slug: string) => {
      await dispatchFromCli(
        'mutate',
        'pipeline',
        'phase.set',
        { phaseId: slug, action: 'start' },
        { command: 'phase' },
      );
    });

  // T5326: Migrated to dispatch
  phase
    .command('complete <slug>')
    .description('Complete a phase (active -> completed)')
    .action(async (slug: string) => {
      await dispatchFromCli(
        'mutate',
        'pipeline',
        'phase.set',
        { phaseId: slug, action: 'complete' },
        { command: 'phase' },
      );
    });

  // T5326: Migrated to dispatch
  phase
    .command('advance')
    .description('Complete current phase and start next')
    .option('-f, --force', 'Skip validation and interactive prompt')
    .action(async (opts: Record<string, unknown>) => {
      await dispatchFromCli(
        'mutate',
        'pipeline',
        'phase.advance',
        {
          force: opts['force'],
        },
        { command: 'phase' },
      );
    });

  // T5326: Migrated to dispatch
  phase
    .command('rename <oldName> <newName>')
    .description('Rename a phase and update all task references')
    .action(async (oldName: string, newName: string) => {
      await dispatchFromCli(
        'mutate',
        'pipeline',
        'phase.rename',
        { oldName, newName },
        { command: 'phase' },
      );
    });

  // T5326: Migrated to dispatch
  phase
    .command('delete <slug>')
    .description('Delete a phase with task reassignment protection')
    .option('--reassign-to <phase>', 'Reassign tasks to another phase')
    .option('--force', 'Required safety flag')
    .action(async (slug: string, opts: Record<string, unknown>) => {
      await dispatchFromCli(
        'mutate',
        'pipeline',
        'phase.delete',
        {
          phaseId: slug,
          reassignTo: opts['reassignTo'],
          force: opts['force'],
        },
        { command: 'phase' },
      );
    });
}
