/**
 * @packageDocumentation
 *
 * CLEO provider adapter for Anthropic Claude Code CLI.
 * Default export is the adapter class for dynamic loading by AdapterManager.
 *
 * @task T5240
 */

import { ClaudeCodeAdapter } from './adapter.js';

export { ClaudeCodeAdapter } from './adapter.js';
export { ClaudeCodeContextMonitorProvider } from './context-monitor.js';
export { ClaudeCodeHookProvider } from './hooks.js';
export { ClaudeCodeInstallProvider } from './install.js';
export { ClaudeCodePathProvider } from './paths.js';
export { ClaudeCodeSpawnProvider } from './spawn.js';
export {
  checkStatuslineIntegration,
  getSetupInstructions,
  getStatuslineConfig,
} from './statusline.js';
export { ClaudeCodeTransportProvider } from './transport.js';

export default ClaudeCodeAdapter;

/**
 * Factory function for creating adapter instances.
 * Used by AdapterManager's dynamic import fallback.
 *
 * @remarks
 * This is the primary entry point for dynamic adapter loading.
 * AdapterManager calls this function when it resolves the claude-code
 * provider via its import-based discovery mechanism.
 *
 * @returns A new {@link ClaudeCodeAdapter} instance ready for initialization
 *
 * @example
 * ```typescript
 * import { createAdapter } from '@cleocode/adapters/providers/claude-code';
 *
 * const adapter = createAdapter();
 * await adapter.initialize('/path/to/project');
 * ```
 */
export function createAdapter(): ClaudeCodeAdapter {
  return new ClaudeCodeAdapter();
}
