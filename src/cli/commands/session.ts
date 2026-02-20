/**
 * CLI session command group.
 * @task T4463
 * @epic T4454
 */

import { Command } from 'commander';
import { getAccessor } from '../../store/data-accessor.js';
import * as sessions from '../../core/sessions/index.js';
import { formatError } from '../../core/output.js';
import { CleoError } from '../../core/errors.js';
import { ExitCode } from '../../types/exit-codes.js';
import { cliOutput } from '../renderers/index.js';

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
    .option('--focus <taskId>', 'Set initial task to work on')
    .option('--agent <agent>', 'Agent identifier')
    .action(async (opts: Record<string, unknown>) => {
      try {
        const accessor = await getAccessor();
        const result = await sessions.startSession({
          name: opts['name'] as string,
          scope: opts['scope'] as string,
          autoStart: opts['autoStart'] as boolean | undefined,
          startTask: opts['startTask'] as string | undefined,
          agent: opts['agent'] as string | undefined,
        }, undefined, accessor);
        cliOutput({ session: result }, { command: 'session', operation: 'session.start' });
      } catch (err) {
        if (err instanceof CleoError) {
          console.error(formatError(err));
          process.exit(err.code);
        }
        throw err;
      }
    });

  session
    .command('stop')
    .alias('end')
    .description('Stop the current session')
    .option('--session <id>', 'Specific session ID to stop')
    .option('--note <note>', 'Stop note')
    .action(async (opts: Record<string, unknown>) => {
      try {
        const accessor = await getAccessor();
        const result = await sessions.endSession({
          sessionId: opts['session'] as string | undefined,
          note: opts['note'] as string | undefined,
        }, undefined, accessor);
        cliOutput({ session: result }, { command: 'session', operation: 'session.stop' });
      } catch (err) {
        if (err instanceof CleoError) {
          console.error(formatError(err));
          process.exit(err.code);
        }
        throw err;
      }
    });

  session
    .command('status')
    .description('Show current session status')
    .action(async () => {
      try {
        const accessor = await getAccessor();
        const result = await sessions.sessionStatus(undefined, accessor);
        if (!result) {
          cliOutput({ session: null }, { command: 'session', message: 'No active session', operation: 'session.status' });
          process.exit(ExitCode.NO_DATA);
        }
        cliOutput({ session: result }, { command: 'session', operation: 'session.status' });
      } catch (err) {
        if (err instanceof CleoError) {
          console.error(formatError(err));
          process.exit(err.code);
        }
        throw err;
      }
    });

  session
    .command('resume <sessionId>')
    .description('Resume an existing session')
    .action(async (sessionId: string) => {
      try {
        const accessor = await getAccessor();
        const result = await sessions.resumeSession(sessionId, undefined, accessor);
        cliOutput({ session: result }, { command: 'session', operation: 'session.resume' });
      } catch (err) {
        if (err instanceof CleoError) {
          console.error(formatError(err));
          process.exit(err.code);
        }
        throw err;
      }
    });

  session
    .command('list')
    .description('List sessions')
    .option('--status <status>', 'Filter by status (active|ended|orphaned)')
    .option('--limit <n>', 'Max results', parseInt)
    .action(async (opts: Record<string, unknown>) => {
      try {
        const accessor = await getAccessor();
        const result = await sessions.listSessions({
          status: opts['status'] as string | undefined,
          limit: opts['limit'] as number | undefined,
        }, undefined, accessor);
        cliOutput({ sessions: result, total: result.length }, { command: 'session', operation: 'session.list' });
      } catch (err) {
        if (err instanceof CleoError) {
          console.error(formatError(err));
          process.exit(err.code);
        }
        throw err;
      }
    });

  session
    .command('gc')
    .description('Garbage collect old sessions')
    .option('--max-age <hours>', 'Max age in hours for active sessions', parseInt)
    .action(async (opts: Record<string, unknown>) => {
      try {
        const accessor = await getAccessor();
        const result = await sessions.gcSessions(opts['maxAge'] as number | undefined, undefined, accessor);
        cliOutput(result, { command: 'session', operation: 'session.gc' });
      } catch (err) {
        if (err instanceof CleoError) {
          console.error(formatError(err));
          process.exit(err.code);
        }
        throw err;
      }
    });
}
