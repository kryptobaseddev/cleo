/**
 * @packageDocumentation
 *
 * CLEO provider adapter for OpenCode AI coding assistant.
 * Default export is the adapter class for dynamic loading by AdapterManager.
 *
 * @task T5240
 */

import { OpenCodeAdapter } from './adapter.js';

export { OpenCodeAdapter } from './adapter.js';
export { OpenCodeHookProvider } from './hooks.js';
export { OpenCodeInstallProvider } from './install.js';
export { OpenCodeSpawnProvider } from './spawn.js';

export default OpenCodeAdapter;

/**
 * Factory function for creating adapter instances.
 * Used by AdapterManager's dynamic import fallback.
 *
 * @remarks
 * This is the primary entry point for dynamic adapter loading.
 * AdapterManager calls this function when it resolves the opencode
 * provider via its import-based discovery mechanism.
 *
 * @returns A new {@link OpenCodeAdapter} instance ready for initialization
 *
 * @example
 * ```typescript
 * import { createAdapter } from '@cleocode/adapters/providers/opencode';
 *
 * const adapter = createAdapter();
 * await adapter.initialize('/path/to/project');
 * ```
 */
export function createAdapter(): OpenCodeAdapter {
  return new OpenCodeAdapter();
}
