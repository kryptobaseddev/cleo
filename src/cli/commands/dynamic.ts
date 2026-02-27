/**
 * Dynamic command registration — thin wrapper around the CLI adapter.
 *
 * Provides registerDynamicCommands() so that src/cli/index.ts can import it
 * via the standard commands/ path. Currently a no-op stub; T4897+ will
 * populate this with auto-generated Commander commands derived from
 * OperationDef.params arrays in the registry.
 *
 * Usage in src/cli/index.ts:
 *   import { registerDynamicCommands } from './commands/dynamic.js';
 *   registerDynamicCommands(program);
 *
 * @epic T4894
 * @task T4900
 */

import type { Command } from 'commander';

/**
 * Register dynamically-generated commands onto the Commander program.
 *
 * Stub implementation: no commands registered until T4897 populates
 * OperationDef.params arrays for all operations.
 */
export function registerDynamicCommands(_program: Command): void {
  // No-op until T4897 populates OperationDef.params arrays.
  // The dispatch layer (getCliDispatcher) handles routing for all operations
  // that already have explicit command registrations in src/cli/commands/.
}
