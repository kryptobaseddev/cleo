/**
 * MCP stdio transport adapter — routes `tools/call` through the gateway.
 *
 * Serves the Model Context Protocol over stdio (newline-delimited JSON-RPC 2.0)
 * so any MCP-compatible client (Claude Code, LLM-agnostic tools) can discover
 * and invoke CLEO operations. Unlike the legacy standalone `@cleocode/mcp-adapter`
 * — which called the `@cleocode/core` SDK directly — this adapter is a thin
 * TRANSPORT over the unified gateway:
 *
 *   MCP `tools/call` { name, arguments }
 *     → {@link GatewayOperationKey} (via the `mcpExposed` registry subset)
 *     → DispatchRequest { source: 'mcp', gateway, domain, operation, params }
 *     → injected {@link GatewayHandler}.handle()
 *     → DispatchResponse (LAFS envelope)  →  MCP tool result (JSON text content)
 *
 * The adapter owns ONLY wire concerns: JSON-RPC framing, the stdio read loop,
 * `tools/list` generation, error rendering, and `process.exit` on stream close.
 * All domain logic (resolution, validation, middleware, handler execution) lives
 * behind the {@link GatewayHandler} — exactly mirroring how the CLI adapter
 * wraps the same handler. `process.exit` and error-render stay HERE, never in
 * the handlers (R3-T4 contract).
 *
 * `tools/list` is generated from the OPERATIONS registry behind the default-deny
 * `mcpExposed` flag, so the external tool surface is identical to the historical
 * standalone adapter (no behavior change).
 *
 * @task T11448
 * @epic T11254
 * @saga T11243
 */

import { randomUUID } from 'node:crypto';
import * as readline from 'node:readline';
import type { DispatchRequest, DispatchResponse } from '@cleocode/contracts/gateway';
import { getLogger } from '@cleocode/core';
import type { GatewayHandler } from '../index.js';
import { toolNameToOperationKey } from './tool-naming.js';
import { buildToolsList, exposedOperations } from './tools-list.js';
import type { McpTool, McpToolResult } from './types.js';

// ---------------------------------------------------------------------------
// JSON-RPC 2.0 envelope helpers
// ---------------------------------------------------------------------------

/** Inbound JSON-RPC request frame. */
interface JsonRpcRequest {
  jsonrpc: '2.0';
  id: number | string | null;
  method: string;
  params?: unknown;
}

/** Outbound JSON-RPC response frame. */
interface JsonRpcResponse {
  jsonrpc: '2.0';
  id: number | string | null;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
}

/** Build a JSON-RPC success response. */
function ok(id: number | string | null, result: unknown): JsonRpcResponse {
  return { jsonrpc: '2.0', id, result };
}

/** Build a JSON-RPC error response. */
function rpcError(id: number | string | null, code: number, message: string): JsonRpcResponse {
  return { jsonrpc: '2.0', id, error: { code, message } };
}

// ---------------------------------------------------------------------------
// Server identity
// ---------------------------------------------------------------------------

/** Advertised MCP server name. */
const SERVER_NAME = 'cleo-gateway-mcp';
/** MCP protocol revision the adapter speaks. */
const PROTOCOL_VERSION = '2024-11-05';
/** Version string advertised in the `initialize` handshake. */
const GATEWAY_MCP_VERSION = '1.0.0';

// ---------------------------------------------------------------------------
// tools/call → gateway routing
// ---------------------------------------------------------------------------

/**
 * Wrap a {@link DispatchResponse} envelope into an MCP tool result.
 *
 * The full LAFS envelope is serialized as the text content so MCP clients see
 * the same `{ success, data, meta, error }` payload every other transport
 * returns. `isError` is set from the envelope's `success` flag.
 *
 * @param response - The gateway dispatch response.
 * @returns An MCP {@link McpToolResult}.
 */
function responseToToolResult(response: DispatchResponse): McpToolResult {
  return {
    content: [{ type: 'text', text: JSON.stringify(response) }],
    isError: response.success ? undefined : true,
  };
}

/**
 * Route a single MCP `tools/call` through the gateway handler.
 *
 * Resolves the tool name to a `(domain, operation)` key against the exposed
 * (`mcpExposed`) registry subset, builds a `source: 'mcp'` {@link DispatchRequest},
 * and delegates to the injected {@link GatewayHandler}. Unknown tool names and
 * thrown handler errors are rendered as MCP error results — never propagated as
 * `process.exit` from this layer.
 *
 * @param handler - The injected transport-neutral gateway handler.
 * @param toolName - The MCP `tools/call` tool name.
 * @param args - The parsed tool arguments (already JSON-decoded by the client).
 * @returns An MCP {@link McpToolResult}.
 */
export async function callTool(
  handler: GatewayHandler,
  toolName: string,
  args: Record<string, unknown>,
): Promise<McpToolResult> {
  const exposed = exposedOperations();
  const key = toolNameToOperationKey(toolName, exposed);
  if (!key) {
    return {
      content: [{ type: 'text', text: `Unknown tool: ${toolName}` }],
      isError: true,
    };
  }

  // The exposed def carries the CQRS gateway — no second lookup needed.
  const def = exposed.find((op) => op.domain === key.domain && op.operation === key.operation);
  if (!def) {
    return {
      content: [{ type: 'text', text: `Unknown tool: ${toolName}` }],
      isError: true,
    };
  }

  const request: DispatchRequest = {
    gateway: def.gateway,
    domain: key.domain,
    operation: key.operation,
    params: args,
    source: 'mcp',
    requestId: randomUUID(),
  };

  try {
    const response = await handler.handle(request);
    return responseToToolResult(response);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return {
      content: [{ type: 'text', text: `Tool execution failed: ${message}` }],
      isError: true,
    };
  }
}

// ---------------------------------------------------------------------------
// JSON-RPC method handlers
// ---------------------------------------------------------------------------

/**
 * Handle a single decoded JSON-RPC request frame.
 *
 * @param handler - The injected gateway handler.
 * @param req - The decoded JSON-RPC request.
 * @returns The JSON-RPC response frame to write back.
 */
async function handleRequest(
  handler: GatewayHandler,
  req: JsonRpcRequest,
): Promise<JsonRpcResponse> {
  const { id, method, params } = req;

  switch (method) {
    case 'initialize':
      return ok(id, {
        protocolVersion: PROTOCOL_VERSION,
        capabilities: { tools: {} },
        serverInfo: { name: SERVER_NAME, version: GATEWAY_MCP_VERSION },
      });

    case 'tools/list':
      return ok(id, { tools: buildToolsList() satisfies McpTool[] });

    case 'tools/call': {
      const p = params as { name?: string; arguments?: Record<string, unknown> } | undefined;
      const toolName = p?.name;
      if (!toolName) {
        return rpcError(id, -32602, 'Missing tool name in params.name');
      }
      const result = await callTool(handler, toolName, p?.arguments ?? {});
      return ok(id, result);
    }

    case 'notifications/initialized':
    case 'ping':
      return ok(id, {});

    default:
      return rpcError(id, -32601, `Method not found: ${method}`);
  }
}

// ---------------------------------------------------------------------------
// stdio server entry point
// ---------------------------------------------------------------------------

/**
 * Options for {@link startMcpServer}.
 */
export interface McpServerOptions {
  /** Inbound stream (defaults to `process.stdin`). */
  input?: NodeJS.ReadableStream;
  /** Outbound stream (defaults to `process.stdout`). */
  output?: NodeJS.WritableStream;
  /**
   * Whether to call `process.exit(0)` when the input stream closes.
   * Defaults to `true` (production stdio). Tests pass `false`.
   */
  exitOnClose?: boolean;
}

/**
 * Start the MCP stdio server over the gateway.
 *
 * Reads newline-delimited JSON-RPC 2.0 requests from the input stream, routes
 * `tools/call` through the injected {@link GatewayHandler}, and writes responses
 * to the output stream. Each inbound line must be one complete JSON-RPC request.
 *
 * The caller assembles the {@link GatewayHandler} (via `createGatewayHandler`
 * with its domain handlers + middleware) and injects it here — this adapter
 * never builds handlers itself, keeping the runtime free of any
 * `@cleocode/cleo` dependency.
 *
 * @param handler - The transport-neutral gateway handler to route through.
 * @param opts - Optional stream + lifecycle overrides (defaults to stdio).
 */
export function startMcpServer(handler: GatewayHandler, opts?: McpServerOptions): void {
  const input = opts?.input ?? process.stdin;
  const output = opts?.output ?? process.stdout;
  const exitOnClose = opts?.exitOnClose ?? true;
  const log = getLogger('gateway-mcp');

  const rl = readline.createInterface({ input, terminal: false });

  rl.on('line', (line) => {
    const trimmed = line.trim();
    if (!trimmed) return;

    let req: JsonRpcRequest;
    try {
      req = JSON.parse(trimmed) as JsonRpcRequest;
    } catch {
      output.write(`${JSON.stringify(rpcError(null, -32700, 'Parse error: invalid JSON'))}\n`);
      return;
    }

    handleRequest(handler, req)
      .then((response) => {
        output.write(`${JSON.stringify(response)}\n`);
      })
      .catch((err: unknown) => {
        const message = err instanceof Error ? err.message : String(err);
        log.warn({ err }, 'mcp request handling failed');
        output.write(
          `${JSON.stringify(rpcError(req.id ?? null, -32603, `Internal error: ${message}`))}\n`,
        );
      });
  });

  rl.on('close', () => {
    if (exitOnClose) process.exit(0);
  });
}
