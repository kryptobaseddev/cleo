/**
 * Grade command - evaluate agent behavior for a completed session.
 * Routes through dispatch layer to admin.grade and admin.grade.list.
 *
 * Usage:
 *   ct grade <sessionId>      Grade a specific session
 *   ct grade --list           List all past grade results
 *
 * @task T4916
 */
import type { Command } from 'commander';
import { dispatchFromCli } from '../../dispatch/adapters/cli.js';

export function registerGradeCommand(program: Command): void {
  program
    .command('grade [sessionId]')
    .description('Grade agent behavior for a session (requires --grade flag on session start)')
    .option('--list', 'List all past grade results')
    .action(async (sessionId: string | undefined, opts: Record<string, unknown>) => {
      if (opts['list'] || !sessionId) {
        await dispatchFromCli('query', 'check', 'grade.list', {}, { command: 'grade' });
      } else {
        await dispatchFromCli('query', 'check', 'grade', { sessionId }, { command: 'grade' });
      }
    });
}
