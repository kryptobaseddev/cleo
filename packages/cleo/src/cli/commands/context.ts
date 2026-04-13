/**
 * CLI context command group - context window monitoring and JIT task context pull.
 *
 * Sub-commands:
 *   cleo context status   — context window state (default)
 *   cleo context check    — scripting exit-code variant
 *   cleo context pull <id> — JIT bundle: task + brain memories + last handoff (T549 Wave 5-A)
 *
 * @task T4535
 * @task T549
 * @epic T4454
 */

import { ExitCode } from '@cleocode/contracts';
import { resolveProjectRoot } from '@cleocode/core/internal';
import { dispatchFromCli } from '../../dispatch/adapters/cli.js';
import { systemContext } from '../../dispatch/engines/system-engine.js';
import type { ShimCommand as Command } from '../commander-shim.js';
import { cliOutput } from '../renderers/index.js';

/** Map context status strings to exit codes for scripting. */
const STATUS_EXIT_CODE: Record<string, ExitCode> = {
  ok: ExitCode.SUCCESS,
  warning: ExitCode.CONTEXT_WARNING,
  caution: ExitCode.CONTEXT_CAUTION,
  critical: ExitCode.CONTEXT_CRITICAL,
  emergency: ExitCode.CONTEXT_EMERGENCY,
  stale: ExitCode.CONTEXT_STALE,
};

export function registerContextCommand(program: Command): void {
  const context = program
    .command('context')
    .description('Monitor context window usage for agent safeguard system');

  context
    .command('status', { isDefault: true })
    .description('Show current context state (default)')
    .option('--session <id>', 'Check specific CLEO session')
    .action(async (opts: Record<string, unknown>) => {
      await dispatchFromCli(
        'query',
        'admin',
        'context',
        {
          action: 'status',
          session: opts['session'],
        },
        { command: 'context' },
      );
    });

  context
    .command('check')
    .description(
      'Check context window state — exits non-zero when threshold exceeded (for scripting)',
    )
    .option('--session <id>', 'Check specific CLEO session')
    .action(async (opts: Record<string, unknown>) => {
      const cwd = resolveProjectRoot();
      const result = systemContext(cwd, {
        session: opts['session'] as string | undefined,
      });
      if (!result.success) {
        console.error(result.error?.message ?? 'Context check failed');
        process.exit(ExitCode.GENERAL_ERROR);
        return;
      }
      const data = result.data;
      if (!data) {
        console.error('Context check returned no data');
        process.exit(ExitCode.GENERAL_ERROR);
        return;
      }
      cliOutput(data, { command: 'context', operation: 'admin.context' });
      const exitCode = STATUS_EXIT_CODE[data.status] ?? ExitCode.SUCCESS;
      if (exitCode !== ExitCode.SUCCESS) {
        process.exit(exitCode);
      }
    });

  // -- pull (T549 Wave 5-A) --
  context
    .command('pull <taskId>')
    .description(
      'JIT context bundle: task details + top-3 relevant brain memories + last handoff note (~400 tokens)',
    )
    .option('--json', 'Output as JSON')
    .action(async (taskId: string, _opts: Record<string, unknown>) => {
      await dispatchFromCli('query', 'admin', 'context.pull', { taskId }, { command: 'context' });
    });
}
