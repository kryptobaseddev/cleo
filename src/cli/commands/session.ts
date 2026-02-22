/**
 * CLI session command group.
 * @task T4463
 * @epic T4454
 */

import { Command } from 'commander';
import { ExitCode } from '../../types/exit-codes.js';
import { cliOutput, cliError } from '../renderers/index.js';
import { dispatchFromCli, dispatchRaw } from '../../dispatch/adapters/cli.js';

/**
 * Register the session command group.
 * @task T4463
 */
export function registerSessionCommand(program: Command): void {
  const session = program
    .command('session')
    .description('Manage work sessions');

  session
    .command('start')
    .description('Start a new session')
    .requiredOption('--scope <scope>', 'Session scope (epic:T### or global)')
    .requiredOption('--name <name>', 'Session name')
    .option('--auto-start', 'Auto-start on first available task')
    .option('--auto-focus', 'Auto-focus on first available task (alias for --auto-start)')
    .option('--focus <taskId>', 'Set initial task to work on')
    .option('--agent <agent>', 'Agent identifier')
    .action(async (opts: Record<string, unknown>) => {
      await dispatchFromCli('mutate', 'session', 'start', {
        scope: opts['scope'] as string,
        name: opts['name'] as string,
        autoStart: (opts['autoStart'] || opts['autoFocus']) as boolean | undefined,
        focus: opts['focus'] as string | undefined,
      }, { command: 'session', operation: 'session.start' });
    });

  session
    .command('stop')
    .alias('end')
    .description('Stop the current session')
    .option('--session <id>', 'Specific session ID to stop')
    .option('--note <note>', 'Stop note')
    .action(async (opts: Record<string, unknown>) => {
      await dispatchFromCli('mutate', 'session', 'end', {
        note: opts['note'] as string | undefined,
      }, { command: 'session', operation: 'session.stop' });
    });

  session
    .command('status')
    .description('Show current session status')
    .action(async () => {
      const response = await dispatchRaw('query', 'session', 'status');
      if (!response.success) {
        cliError(response.error?.message ?? 'Unknown error', response.error?.exitCode ?? 1);
        process.exit(response.error?.exitCode ?? 1);
        return;
      }
      const data = response.data as Record<string, unknown> | null;
      if (!data || (data['session'] === null) || (data['session'] === undefined && !data['id'])) {
        cliOutput({ session: null }, { command: 'session', message: 'No active session', operation: 'session.status' });
        process.exit(ExitCode.NO_DATA);
        return;
      }
      cliOutput({ session: data }, { command: 'session', operation: 'session.status' });
    });

  session
    .command('resume <sessionId>')
    .description('Resume an existing session')
    .action(async (sessionId: string) => {
      await dispatchFromCli('mutate', 'session', 'resume', {
        sessionId,
      }, { command: 'session', operation: 'session.resume' });
    });

  session
    .command('list')
    .description('List sessions')
    .option('--status <status>', 'Filter by status (active|ended|orphaned)')
    .option('--limit <n>', 'Max results', parseInt)
    .action(async (opts: Record<string, unknown>) => {
      const status = opts['status'] as string | undefined;
      await dispatchFromCli('query', 'session', 'list', {
        active: status === 'active' ? true : undefined,
        limit: opts['limit'] as number | undefined,
      }, { command: 'session', operation: 'session.list' });
    });

  session
    .command('gc')
    .description('Garbage collect old sessions')
    .option('--max-age <hours>', 'Max age in hours for active sessions', parseInt)
    .action(async (opts: Record<string, unknown>) => {
      await dispatchFromCli('mutate', 'session', 'gc', {
        maxAgeDays: opts['maxAge'] as number | undefined,
      }, { command: 'session', operation: 'session.gc' });
    });
}
