/**
 * Gemini CLI provider adapter.
 *
 * CLEO provider adapter for Google Gemini CLI.
 * Default export is the adapter class for dynamic loading by AdapterManager.
 *
 * @task T161
 * @epic T134
 */

import { GeminiCliAdapter } from './adapter.js';

export { GeminiCliAdapter } from './adapter.js';
export { GeminiCliHookProvider } from './hooks.js';
export { GeminiCliInstallProvider } from './install.js';

export default GeminiCliAdapter;

/**
 * Factory function for creating adapter instances.
 * Used by AdapterManager's dynamic import fallback.
 *
 * @task T161
 */
export function createAdapter(): GeminiCliAdapter {
  return new GeminiCliAdapter();
}
