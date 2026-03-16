/**
 * @cleocode/adapter-claude-code
 *
 * CLEO provider adapter for Anthropic Claude Code CLI.
 * Default export is the adapter class for dynamic loading by AdapterManager.
 *
 * @task T5240
 */

import { ClaudeCodeAdapter } from './adapter.js';

export { ClaudeCodeAdapter } from './adapter.js';
export { ClaudeCodeHookProvider } from './hooks.js';
export { ClaudeCodeSpawnProvider } from './spawn.js';
export { ClaudeCodeInstallProvider } from './install.js';

export default ClaudeCodeAdapter;

/**
 * Factory function for creating adapter instances.
 * Used by AdapterManager's dynamic import fallback.
 */
export function createAdapter(): ClaudeCodeAdapter {
  return new ClaudeCodeAdapter();
}
