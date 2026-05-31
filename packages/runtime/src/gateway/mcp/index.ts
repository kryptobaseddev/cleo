/**
 * `@cleocode/runtime/gateway/mcp` — the MCP transport adapter.
 *
 * A thin Model Context Protocol adapter over the unified gateway. It serves
 * MCP JSON-RPC over stdio and maps every `tools/call` onto a
 * `source: 'mcp'` gateway request routed through an injected
 * {@link GatewayHandler} (built with `createGatewayHandler`). `tools/list` is
 * generated from the OPERATIONS registry behind the default-deny `mcpExposed`
 * flag, so the exposed tool SET is identical to the historical standalone
 * `@cleocode/mcp-adapter` — no behavior change.
 *
 * Mirrors the `@cleocode/runtime/daemon` subpath pattern: this is a transport
 * adapter OWNED by the runtime layer, consuming the gateway contract from
 * `@cleocode/contracts/gateway` and the dispatcher core from
 * `@cleocode/runtime/gateway`. It carries NO `@cleocode/cleo` dependency.
 *
 * @packageDocumentation
 * @module @cleocode/runtime/gateway/mcp
 *
 * @task T11448
 * @epic T11254
 * @saga T11243
 */

export {
  callTool,
  type McpServerOptions,
  startMcpServer,
} from './server.js';
export {
  type GatewayOperationKey,
  MCP_TOOL_PREFIX,
  operationToToolName,
  toolNameToOperationKey,
} from './tool-naming.js';
export {
  buildToolsList,
  exposedOperations,
  operationToMcpTool,
} from './tools-list.js';
export type { McpContent, McpInputProperty, McpTool, McpToolResult } from './types.js';
