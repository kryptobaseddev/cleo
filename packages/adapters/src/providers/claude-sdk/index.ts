/**
 * @packageDocumentation
 *
 * Claude Agent SDK spawn provider for CLEO.
 * Uses `@anthropic-ai/claude-agent-sdk` instead of the CLI for programmatic
 * subagent execution with structured output and session tracking.
 *
 * Enabled via `provider.claude.mode = 'sdk'` in CLEO config.
 *
 * @task T581
 */

export type { McpServerMap, McpStdioConfig } from './mcp-registry.js';
export { getServers } from './mcp-registry.js';
export type { SessionEntry } from './session-store.js';
export { SessionStore } from './session-store.js';
export { ClaudeSDKSpawnProvider } from './spawn.js';
export { DEFAULT_TOOLS, resolveTools } from './tool-bridge.js';
