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
export { ClaudeCodeContextMonitorProvider } from './context-monitor.js';
export { ClaudeCodeHookProvider } from './hooks.js';
export { ClaudeCodeInstallProvider } from './install.js';
export { ClaudeCodePathProvider } from './paths.js';
export { ClaudeCodeSpawnProvider } from './spawn.js';
export { ClaudeCodeTransportProvider } from './transport.js';
export { checkStatuslineIntegration, getStatuslineConfig, getSetupInstructions, } from './statusline.js';
export default ClaudeCodeAdapter;
/**
 * Factory function for creating adapter instances.
 * Used by AdapterManager's dynamic import fallback.
 */
export function createAdapter() {
    return new ClaudeCodeAdapter();
}
//# sourceMappingURL=index.js.map