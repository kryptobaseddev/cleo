/**
 * @packageDocumentation
 *
 * Unified provider adapter package for CLEO.
 * Exports all provider adapters and a registry for manifest discovery.
 *
 * @remarks
 * This package is the single entry point for all CLEO provider adapters.
 * Each provider (Claude Code, Cursor, OpenCode, Codex, Gemini CLI, Kimi)
 * exposes an adapter class implementing {@link CLEOProviderAdapter} from
 * `@cleocode/contracts`, plus supporting hook, install, and spawn providers.
 * The {@link discoverProviders} function and {@link getProviderManifests}
 * registry enable dynamic adapter loading by AdapterManager.
 */

// Re-export adapter classes for direct use
// Per-provider factory functions (renamed to avoid collisions)
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
  CodexAdapter,
  CodexHookProvider,
  CodexInstallProvider,
  createAdapter as createCodexAdapter,
} from './providers/codex/index.js';
export {
  CursorAdapter,
  CursorHookProvider,
  CursorInstallProvider,
  createAdapter as createCursorAdapter,
} from './providers/cursor/index.js';
export {
  createAdapter as createGeminiCliAdapter,
  GeminiCliAdapter,
  GeminiCliHookProvider,
  GeminiCliInstallProvider,
} from './providers/gemini-cli/index.js';
export {
  createAdapter as createKimiAdapter,
  KimiAdapter,
  KimiHookProvider,
  KimiInstallProvider,
} from './providers/kimi/index.js';
export {
  createAdapter as createOpenCodeAdapter,
  OpenCodeAdapter,
  OpenCodeHookProvider,
  OpenCodeInstallProvider,
  OpenCodeSpawnProvider,
} from './providers/opencode/index.js';
export type { AdapterManifest } from './registry.js';
export { discoverProviders, getProviderManifests } from './registry.js';
