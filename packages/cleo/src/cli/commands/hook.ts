/**
 * CLI command: cleo hook heavy-command [--provider <p>]
 *
 * Hooks CLEO installs into agent harnesses. Each subcommand reads the
 * harness's hook payload on stdin and answers in the harness's own protocol on
 * stdout (not a LAFS envelope). `bin/cleo.js` short-circuits `cleo hook …` to
 * the same runtime without the CLI bootstrap, because the heavy-command hook
 * runs before every shell command an agent issues. The runtime lives in
 * `../hook-entry.ts`.
 *
 * @task T12983
 * @epic T12978
 */

import { defineCommand, showUsage } from '../lib/define-cli-command.js';

const heavyCommandSubcommand = defineCommand({
  meta: {
    name: 'heavy-command',
    description:
      'PreToolUse hook: route heavy shell commands (tests, builds, typechecks, installs) through cleo run. Reads the hook JSON on stdin; prints the harness answer.',
  },
  args: {
    provider: {
      type: 'string',
      description: 'Harness protocol to answer in: claude-code (default), codex, kimi, opencode',
    },
  },
  async run({ args }) {
    const { runHookCli } = await import('../hook-entry.js');
    const provider = typeof args.provider === 'string' ? args.provider : 'claude-code';
    process.exitCode = await runHookCli(['heavy-command', '--provider', provider]);
  },
});

/** cleo hook — agent-harness hooks (stdout is the harness protocol). */
export const hookCommand = defineCommand({
  meta: {
    name: 'hook',
    description:
      'Agent-harness hooks installed by cleo init/upgrade; stdout is the harness hook protocol, not LAFS: cleo hook heavy-command --provider claude-code|codex|kimi|opencode',
  },
  subCommands: {
    'heavy-command': heavyCommandSubcommand,
  },
  async run({ cmd, rawArgs }) {
    const firstArg = rawArgs?.find((a) => !a.startsWith('-'));
    if (firstArg && cmd.subCommands && firstArg in cmd.subCommands) return;
    await showUsage(cmd);
  },
});
