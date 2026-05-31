/**
 * Public API for the CLEO MCP Adapter.
 *
 * External stub that exposes CLEO sentient operations as MCP tools.
 * Uses `@cleocode/core` SDK directly — no CLI subprocess.
 *
 * @deprecated Superseded by `@cleocode/runtime/gateway/mcp` (R3-T4 · T11448 ·
 * SG-RUNTIME-UNIFICATION). The unified adapter serves the SAME tool surface but
 * routes every `tools/call` through the gateway (`source: 'mcp'`) instead of
 * calling the `@cleocode/core` SDK directly, and generates `tools/list` from the
 * OPERATIONS registry behind the default-deny `mcpExposed` flag. This package is
 * retained for one deprecation cycle so existing consumers keep working; new
 * integrations MUST import {@link startMcpServer} from `@cleocode/runtime/gateway/mcp`.
 *
 * @task T1485 — MCP adapter SDK migration (T948 prerequisite)
 * @task T11448 — deprecate in favour of the gateway-routed MCP adapter
 */

export { startServer } from './server.js';
export { ALL_TOOLS, handleToolCall } from './tools.js';
export type { McpContent, McpTool, McpToolResult } from './types.js';
