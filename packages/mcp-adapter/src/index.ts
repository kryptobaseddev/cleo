/**
 * Public API for the CLEO MCP Adapter.
 *
 * External stub that exposes CLEO sentient operations as MCP tools.
 * Uses `@cleocode/core` SDK directly — no CLI subprocess.
 *
 * @task T1485 — MCP adapter SDK migration (T948 prerequisite)
 */

export { startServer } from './server.js';
export { ALL_TOOLS, handleToolCall } from './tools.js';
export type { McpContent, McpTool, McpToolResult } from './types.js';
