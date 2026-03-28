/**
 * CLI agents command — alias for `cleo agent` (backward compatibility).
 *
 * The `agents` (plural) command existed before the unified `agent` command.
 * It now redirects to `agent` to avoid citty routing conflicts.
 * The `health` subcommand is registered directly on the `agent` parent.
 *
 * @deprecated Use `cleo agent health` instead of `cleo agents health`.
 * @task T039
 */

import type { ShimCommand as Command } from '../commander-shim.js';

/**
 * Register `agents` as an alias that prints deprecation notice.
 * Health monitoring is now under `cleo agent health`.
 */
export function registerAgentsCommand(_program: Command): void {
  // No-op: the `agents` command is removed to avoid collision with `agent`.
  // Health monitoring lives under `cleo agent health`.
  // This function is kept to avoid breaking the import in index.ts.
}
