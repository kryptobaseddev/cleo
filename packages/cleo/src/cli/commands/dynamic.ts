/**
 * Dynamic command registration stub.
 *
 * Currently a no-op; T4897+ will populate this with auto-generated citty
 * subcommands derived from OperationDef.params arrays in the registry.
 *
 * @epic T4894
 * @task T4900
 */

import { defineCommand } from 'citty';

/**
 * Stub dynamic command — no operations registered until T4897 populates
 * OperationDef.params arrays for all operations.
 */
export const dynamicCommand = defineCommand({
  meta: { name: 'dynamic', description: 'STUB — auto-generated commands (T4897)' },
  async run() {
    // No-op until T4897 populates OperationDef.params arrays.
  },
});
