/**
 * CLI command group: `cleo auth` — unified credential view + removal.
 *
 * Sister surface to `cleo llm` — where `cleo llm` is scoped to the
 * LLM-credential pool (the `llm-credentials.json` store), `cleo auth` walks
 * every registered seeder so the operator sees the complete unified view
 * (env, claude-code, cleo-pkce, codex-cli, gemini-cli, gh-cli, manual).
 *
 * Subcommands:
 *   cleo auth list [--provider P] [--json]    — full pool listing
 *   cleo auth remove <provider> <label>       — invoke per-source RemovalStep
 *
 * @task T9416
 * @epic E-CONFIG-AUTH-UNIFY (E2b §5.2 T-E2-8)
 */

import { defineCommand, showUsage } from 'citty';
import { authListCommand, authRemoveCommand } from './auth/index.js';

/**
 * `cleo auth` — unified credential surface.
 *
 * @task T9416
 */
export const authCommand = defineCommand({
  meta: {
    name: 'auth',
    description:
      'Unified credential view across all seeded sources (cleo llm list is the LLM-scoped sister command).',
  },
  subCommands: {
    list: authListCommand,
    remove: authRemoveCommand,
  },
  async run({ cmd, rawArgs }) {
    const firstArg = rawArgs?.find((a) => !a.startsWith('-'));
    if (firstArg && cmd.subCommands && firstArg in cmd.subCommands) return;
    await showUsage(cmd);
  },
});
