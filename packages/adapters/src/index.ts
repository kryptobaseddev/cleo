/**
 * @cleocode/adapters
 *
 * Unified provider adapter package for CLEO.
 * Exports all provider adapters and a registry for manifest discovery.
 */

export { discoverProviders, getProviderManifests } from './registry.js';
export type { AdapterManifest } from './registry.js';

// Re-export adapter classes for direct use
export { ClaudeCodeAdapter } from './providers/claude-code/index.js';
export { ClaudeCodeContextMonitorProvider } from './providers/claude-code/index.js';
export { ClaudeCodeHookProvider } from './providers/claude-code/index.js';
export { ClaudeCodeInstallProvider } from './providers/claude-code/index.js';
export { ClaudeCodePathProvider } from './providers/claude-code/index.js';
export { ClaudeCodeSpawnProvider } from './providers/claude-code/index.js';
export { ClaudeCodeTransportProvider } from './providers/claude-code/index.js';
export {
  checkStatuslineIntegration,
  getStatuslineConfig,
  getSetupInstructions,
} from './providers/claude-code/index.js';

export { OpenCodeAdapter } from './providers/opencode/index.js';
export { OpenCodeHookProvider } from './providers/opencode/index.js';
export { OpenCodeSpawnProvider } from './providers/opencode/index.js';
export { OpenCodeInstallProvider } from './providers/opencode/index.js';

export { CursorAdapter } from './providers/cursor/index.js';
export { CursorHookProvider } from './providers/cursor/index.js';
export { CursorInstallProvider } from './providers/cursor/index.js';

// Per-provider factory functions (renamed to avoid collisions)
export { createAdapter as createClaudeCodeAdapter } from './providers/claude-code/index.js';
export { createAdapter as createOpenCodeAdapter } from './providers/opencode/index.js';
export { createAdapter as createCursorAdapter } from './providers/cursor/index.js';
