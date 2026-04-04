/**
 * @packageDocumentation
 *
 * CLEO provider adapter for Moonshot AI Kimi.
 * Default export is the adapter class for dynamic loading by AdapterManager.
 *
 * @task T163
 * @epic T134
 */

import { KimiAdapter } from './adapter.js';

export { KimiAdapter } from './adapter.js';
export { KimiHookProvider } from './hooks.js';
export { KimiInstallProvider } from './install.js';

export default KimiAdapter;

/**
 * Factory function for creating adapter instances.
 * Used by AdapterManager's dynamic import fallback.
 *
 * @remarks
 * This is the primary entry point for dynamic adapter loading.
 * AdapterManager calls this function when it resolves the kimi
 * provider via its import-based discovery mechanism.
 *
 * @returns A new {@link KimiAdapter} instance ready for initialization
 *
 * @example
 * ```typescript
 * import { createAdapter } from '@cleocode/adapters/providers/kimi';
 *
 * const adapter = createAdapter();
 * await adapter.initialize('/path/to/project');
 * ```
 *
 * @task T163
 */
export function createAdapter(): KimiAdapter {
  return new KimiAdapter();
}
