/**
 * @packageDocumentation
 *
 * Claude SDK spawn provider for CLEO — Vercel AI SDK edition.
 *
 * Uses `@ai-sdk/anthropic` via the Vercel AI SDK (`ai` v6) instead of the
 * legacy `@anthropic-ai/claude-agent-sdk`. CLEO retains its own orchestration
 * primitives (composeSpawnPayload, playbook runtime, agent registry); this
 * provider exposes the LLM bridge for programmatic subagent execution with
 * structured output and session tracking.
 *
 * Enabled via `provider.claude.mode = 'sdk'` in CLEO config.
 *
 * @task T581 (original)
 * @task T933 (SDK consolidation — Vercel AI SDK migration)
 * @see ADR-052 — SDK consolidation decision
 */

export type { McpServerMap, McpStdioConfig } from './mcp-registry.js';
export { getServers } from './mcp-registry.js';
export type { SessionEntry } from './session-store.js';
export { SessionStore } from './session-store.js';
export { ClaudeSDKSpawnProvider } from './spawn.js';
export { DEFAULT_TOOLS, resolveTools } from './tool-bridge.js';
