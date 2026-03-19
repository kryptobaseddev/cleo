/**
 * @cleocode/adapters
 *
 * Unified provider adapter package for CLEO.
 * Exports all provider adapters and a registry for manifest discovery.
 */
export {
  ClaudeCodeAdapter,
  ClaudeCodeContextMonitorProvider,
  ClaudeCodeHookProvider,
  ClaudeCodeInstallProvider,
  ClaudeCodePathProvider,
  ClaudeCodeSpawnProvider,
  ClaudeCodeTransportProvider,
  checkStatuslineIntegration,
  createAdapter as createClaudeCodeAdapter,
  getSetupInstructions,
  getStatuslineConfig,
} from './providers/claude-code/index.js';
export {
  CursorAdapter,
  CursorHookProvider,
  CursorInstallProvider,
  createAdapter as createCursorAdapter,
} from './providers/cursor/index.js';
export {
  createAdapter as createOpenCodeAdapter,
  OpenCodeAdapter,
  OpenCodeHookProvider,
  OpenCodeInstallProvider,
  OpenCodeSpawnProvider,
} from './providers/opencode/index.js';
export type { AdapterManifest } from './registry.js';
export { discoverProviders, getProviderManifests } from './registry.js';
//# sourceMappingURL=index.d.ts.map
