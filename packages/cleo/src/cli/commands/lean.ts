/**
 * CLI command group: cleo lean — ct-lean levels (T13663).
 *
 * `cleo lean level` shows the effective level and where it came from;
 * `cleo lean level <off|lite|full|ultra>` sets it in the project config,
 * `--global` in the global config, `--session` for the current CLEO session
 * only. The environment variable `CLEO_LEAN_LEVEL` overrides all of them.
 * Logic lives in `@cleocode/core/orchestration/lean-change`.
 *
 * @task T13663
 * @epic T13418
 */

import { ExitCode } from '@cleocode/contracts/exit-codes.js';
import { defineCommand, showUsage } from '../lib/define-cli-command.js';
import { cliError, cliOutput } from '../renderers/index.js';

const levelSubcommand = defineCommand({
  meta: {
    name: 'level',
    description:
      'Show the effective ct-lean level, or set it: off | lite | full (default) | ultra. Writes the project config unless --global or --session.',
  },
  args: {
    level: { type: 'positional', required: false, description: 'off | lite | full | ultra' },
    session: { type: 'boolean', description: 'Set the level for the current CLEO session only' },
    global: { type: 'boolean', description: 'Set the level in the global config (~/.cleo)' },
  },
  async run({ args }) {
    const lean = await import('@cleocode/core/orchestration/lean-change.js');
    const { getProjectRoot } = await import('@cleocode/core/project-scope');
    const { resolveBoundSessionId } = await import('@cleocode/core/internal');
    const projectRoot = getProjectRoot();
    const sessionId = await resolveBoundSessionId(projectRoot).catch(() => null);
    const raw = typeof args.level === 'string' ? args.level : undefined;
    if (raw === undefined) {
      const resolved = await lean.effectiveLeanLevel({ projectRoot, sessionId });
      cliOutput(resolved, { command: 'lean-level', operation: 'lean.level.get' });
      return;
    }
    const level = lean.LEAN_LEVELS.find((l) => l === raw.trim().toLowerCase());
    if (level === undefined || (args.session && args.global)) {
      cliError(
        level === undefined
          ? `lean level: unknown level "${raw}" (use off | lite | full | ultra)`
          : 'lean level: choose --session or --global, not both',
        ExitCode.INVALID_INPUT,
        { name: 'E_INVALID_INPUT' },
      );
      process.exit(ExitCode.INVALID_INPUT);
      return;
    }
    const scope = args.session ? 'session' : args.global ? 'global' : 'project';
    try {
      const written = await lean.setLeanLevel({ projectRoot, level, scope, sessionId });
      cliOutput(written, { command: 'lean-level', operation: 'lean.level.set' });
    } catch (err) {
      cliError(
        `lean level: ${err instanceof Error ? err.message : String(err)}`,
        ExitCode.GENERAL_ERROR,
        {
          name: 'E_LEAN_LEVEL_FAILED',
        },
      );
      process.exit(ExitCode.GENERAL_ERROR);
    }
  },
});

/** cleo lean — ct-lean levels and tools. */
export const leanCommand = defineCommand({
  meta: {
    name: 'lean',
    description:
      'ct-lean (smallest complete change) levels and tools: cleo lean level [off|lite|full|ultra] [--session|--global]',
  },
  subCommands: {
    level: levelSubcommand,
  },
  async run({ cmd, rawArgs }) {
    const firstArg = rawArgs?.find((a) => !a.startsWith('-'));
    if (firstArg && cmd.subCommands && firstArg in cmd.subCommands) return;
    await showUsage(cmd);
  },
});
