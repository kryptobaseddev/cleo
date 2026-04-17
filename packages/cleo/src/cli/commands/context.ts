/**
 * CLI context command group — context window monitoring and JIT task context pull.
 *
 * Sub-commands:
 *   cleo context status    — context window state (default when no subcommand given)
 *   cleo context check     — scripting exit-code variant
 *   cleo context pull <id> — JIT bundle: task + brain memories + last handoff (T549 Wave 5-A)
 *
 * @task T4535
 * @task T549
 * @epic T4454
 */

import { ExitCode } from '@cleocode/contracts';
import { resolveProjectRoot } from '@cleocode/core/internal';
import { defineCommand } from 'citty';
import { dispatchFromCli } from '../../dispatch/adapters/cli.js';
import { systemContext } from '../../dispatch/engines/system-engine.js';
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

/** cleo context status — show current context window state */
const statusCommand = defineCommand({
  meta: { name: 'status', description: 'Show current context state (default)' },
  args: {
    session: {
      type: 'string',
      description: 'Check specific CLEO session',
    },
  },
  async run({ args }) {
    await dispatchFromCli(
      'query',
      'admin',
      'context',
      {
        action: 'status',
        session: args.session as string | undefined,
      },
      { command: 'context' },
    );
  },
});

/** cleo context check — exits non-zero when threshold exceeded (for scripting) */
const checkCommand = defineCommand({
  meta: {
    name: 'check',
    description:
      'Check context window state — exits non-zero when threshold exceeded (for scripting)',
  },
  args: {
    session: {
      type: 'string',
      description: 'Check specific CLEO session',
    },
  },
  async run({ args }) {
    const cwd = resolveProjectRoot();
    const result = systemContext(cwd, {
      session: args.session as string | undefined,
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
  },
});

/** cleo context pull <taskId> — JIT context bundle for a task */
const pullCommand = defineCommand({
  meta: {
    name: 'pull',
    description:
      'JIT context bundle: task details + top-3 relevant brain memories + last handoff note (~400 tokens)',
  },
  args: {
    taskId: {
      type: 'positional',
      description: 'Task ID to pull context for',
      required: true,
    },
    json: {
      type: 'boolean',
      description: 'Output as JSON',
    },
  },
  async run({ args }) {
    await dispatchFromCli(
      'query',
      'admin',
      'context.pull',
      { taskId: args.taskId },
      { command: 'context' },
    );
  },
});

/**
 * Root context command group — registers status, check, and pull subcommands.
 *
 * When no subcommand is provided, falls back to running the `status` subcommand.
 */
export const contextCommand = defineCommand({
  meta: {
    name: 'context',
    description: 'Monitor context window usage for agent safeguard system',
  },
  subCommands: {
    status: statusCommand,
    check: checkCommand,
    pull: pullCommand,
  },
  async run({ rawArgs }) {
    // Default to status when no subcommand is given
    const hasSubcommand = rawArgs.some((a) => ['status', 'check', 'pull'].includes(a));
    if (!hasSubcommand) {
      await dispatchFromCli(
        'query',
        'admin',
        'context',
        { action: 'status' },
        { command: 'context' },
      );
    }
  },
});
