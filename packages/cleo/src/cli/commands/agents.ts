/**
 * CLI agents command — deprecated stub (backward compatibility).
 *
 * The `agents` (plural) command existed before the unified `agent` command.
 * All agent functionality now lives under `cleo agent`.
 *
 * @deprecated Use `cleo agent` instead of `cleo agents`.
 * @task T039
 */

import { defineCommand } from 'citty';

/**
 * Deprecated agents command group — no-op stub preserved for backward
 * compatibility. Health monitoring and all agent operations now live under
 * `cleo agent`.
 *
 * @deprecated Use `cleo agent health` instead of `cleo agents health`.
 */
export const agentsCommand = defineCommand({
  meta: { name: 'agents', description: 'DEPRECATED — use `cleo agent` instead' },
  async run() {},
});
