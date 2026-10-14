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

const debtSubcommand = defineCommand({
  meta: {
    name: 'debt',
    description:
      'Ledger of every `shortcut:` (or `ponytail:`) comment in git-tracked files, with its limit, upgrade trigger and a no-trigger flag. --file-tasks files one lean-debt task per new marker under --parent.',
  },
  args: {
    marker: {
      type: 'string',
      description: 'Marker word to scan instead of shortcut/ponytail (e.g. TODO)',
    },
    'file-tasks': {
      type: 'boolean',
      description: 'File one lean-debt task per marker that has none yet',
    },
    parent: {
      type: 'string',
      description: 'Parent epic for filed tasks (required with --file-tasks)',
    },
  },
  async run({ args }) {
    const fileTasks = args['file-tasks'] === true;
    const parentId = typeof args.parent === 'string' ? args.parent : undefined;
    if (fileTasks && !parentId) {
      cliError('lean debt: --file-tasks needs --parent <epicId>', ExitCode.INVALID_INPUT, {
        name: 'E_INVALID_INPUT',
      });
      process.exit(ExitCode.INVALID_INPUT);
      return;
    }
    const { leanDebtReport } = await import('@cleocode/core/orchestration/lean-debt.js');
    const { getProjectRoot } = await import('@cleocode/core/project-scope');
    try {
      const report = await leanDebtReport({
        projectRoot: getProjectRoot(),
        ...(typeof args.marker === 'string' && args.marker.trim()
          ? { markers: [args.marker.trim()] }
          : {}),
        fileTasks,
        ...(parentId ? { parentId } : {}),
      });
      cliOutput(report, { command: 'lean-debt', operation: 'lean.debt' });
    } catch (err) {
      cliError(
        `lean debt: ${err instanceof Error ? err.message : String(err)}`,
        ExitCode.GENERAL_ERROR,
        {
          name: 'E_LEAN_DEBT_FAILED',
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
      'ct-lean (smallest complete change) levels and tools: cleo lean level [off|lite|full|ultra] [--session|--global] · cleo lean debt [--file-tasks --parent <epic>]',
  },
  subCommands: {
    level: levelSubcommand,
    debt: debtSubcommand,
  },
  async run({ cmd, rawArgs }) {
    const firstArg = rawArgs?.find((a) => !a.startsWith('-'));
    if (firstArg && cmd.subCommands && firstArg in cmd.subCommands) return;
    await showUsage(cmd);
  },
});
