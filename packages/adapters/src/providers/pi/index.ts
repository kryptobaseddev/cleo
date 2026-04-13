/**
 * @packageDocumentation
 *
 * CLEO provider adapter for Pi coding agent (https://github.com/badlogic/pi-mono).
 * Pi is CAAMP's first-class primary harness with 11/16 canonical hook events.
 * Default export is the adapter class for dynamic loading by AdapterManager.
 *
 * @task T553
 */

import { PiAdapter } from './adapter.js';

export { PiAdapter } from './adapter.js';
export { PiHookProvider } from './hooks.js';
export { PiInstallProvider } from './install.js';
export { PiSpawnProvider } from './spawn.js';

export default PiAdapter;

/**
 * Factory function for creating Pi adapter instances.
 * Used by AdapterManager's dynamic import fallback.
 *
 * @remarks
 * This is the primary entry point for dynamic adapter loading.
 * AdapterManager calls this function when it resolves the pi provider
 * via its import-based discovery mechanism.
 *
 * @returns A new {@link PiAdapter} instance ready for initialization
 *
 * @example
 * ```typescript
 * import { createAdapter } from '@cleocode/adapters/providers/pi';
 *
 * const adapter = createAdapter();
 * await adapter.initialize('/path/to/project');
 * ```
 */
export function createAdapter(): PiAdapter {
  return new PiAdapter();
}
