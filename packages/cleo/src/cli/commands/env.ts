/**
 * CLI command group for environment and mode inspection.
 *
 * Exposes two subcommands:
 *
 *   cleo env status  — show current environment mode and runtime info (default)
 *   cleo env info    — show detailed environment info including binary paths
 *
 * The parent `run()` falls through to `status` when no subcommand is provided,
 * replicating the Commander `isDefault: true` behaviour.
 *
 * @task T4581
 * @epic T4577
 */

import { getRuntimeDiagnostics } from '@cleocode/core/internal';
import { defineCommand } from 'citty';
import { cliOutput } from '../renderers/index.js';

/** cleo env status — show current environment mode and runtime info */
const statusCommand = defineCommand({
  meta: { name: 'status', description: 'Show current environment mode and runtime info' },
  async run() {
    const result = await getRuntimeDiagnostics({ detailed: false });
    cliOutput(result, { command: 'env' });
  },
});

/** cleo env info — show detailed environment info including binary paths and compilation status */
const infoCommand = defineCommand({
  meta: {
    name: 'info',
    description: 'Show detailed environment info including binary paths and compilation status',
  },
  async run() {
    const result = await getRuntimeDiagnostics({ detailed: true });
    cliOutput(result, { command: 'env' });
  },
});

/**
 * Root env command group — registers status (default) and info subcommands.
 *
 * When invoked with no subcommand (`cleo env`), the `run` handler falls
 * through to `status` to match the original Commander `isDefault: true`
 * behaviour.
 */
export const envCommand = defineCommand({
  meta: { name: 'env', description: 'Environment and mode inspection' },
  subCommands: {
    status: statusCommand,
    info: infoCommand,
  },
  async run(ctx) {
    // No subcommand supplied — invoke default (status).
    const hasSubcommand = ctx.rawArgs.some((a) => ['status', 'info'].includes(a));
    if (!hasSubcommand) {
      const result = await getRuntimeDiagnostics({ detailed: false });
      cliOutput(result, { command: 'env' });
    }
  },
});
