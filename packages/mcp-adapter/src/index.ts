/**
 * Public API for the CLEO MCP Adapter.
 *
 * External-only stub that exposes CLEO sentient operations as MCP tools.
 * Does NOT import or wire into internal CLEO dispatch.
 *
 * @task T1148 W8-9
 */

export { runCleo } from './cli-runner.js';
export { startServer } from './server.js';
export { ALL_TOOLS, handleToolCall } from './tools.js';
export type { CliResult, McpContent, McpTool, McpToolResult } from './types.js';
