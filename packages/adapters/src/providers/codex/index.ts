/**
 * Codex CLI provider adapter.
 *
 * CLEO provider adapter for OpenAI Codex CLI.
 * Default export is the adapter class for dynamic loading by AdapterManager.
 *
 * @task T162
 * @epic T134
 */

import { CodexAdapter } from './adapter.js';

export { CodexAdapter } from './adapter.js';
export { CodexHookProvider } from './hooks.js';
export { CodexInstallProvider } from './install.js';

export default CodexAdapter;

/**
 * Factory function for creating adapter instances.
 * Used by AdapterManager's dynamic import fallback.
 *
 * @task T162
 */
export function createAdapter(): CodexAdapter {
  return new CodexAdapter();
}
