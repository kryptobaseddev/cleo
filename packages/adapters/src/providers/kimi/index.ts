/**
 * Kimi provider adapter.
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
 * @task T163
 */
export function createAdapter(): KimiAdapter {
  return new KimiAdapter();
}
