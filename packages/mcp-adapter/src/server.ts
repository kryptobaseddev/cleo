/**
 * Minimal MCP server stub for the CLEO external adapter.
 *
 * Implements the MCP JSON-RPC 2.0 transport over stdio (stdin/stdout) so any
 * MCP-compatible client (Claude Code, LLM-agnostic tools) can discover and
 * call CLEO sentient operations without importing internal CLEO packages.
 *
 * Protocol flow:
 *   client → {"jsonrpc":"2.0","method":"initialize",...}      → server
 *   server → capabilities (tools list)                        → client
 *   client → {"jsonrpc":"2.0","method":"tools/call",...}      → server
 *   server → {"jsonrpc":"2.0","result":{"content":[...]}}     → client
 *
 * This is an external-only stub.  Internal CLEO dispatch is NOT wired.
 *
 * @task T1148 W8-9
 */

import * as readline from 'node:readline';
import { ALL_TOOLS, handleToolCall } from './tools.js';
import type { McpToolResult } from './types.js';

// ---------------------------------------------------------------------------
// JSON-RPC 2.0 envelope helpers
// ---------------------------------------------------------------------------

interface JsonRpcRequest {
  jsonrpc: '2.0';
  id: number | string | null;
  method: string;
  params?: unknown;
}

interface JsonRpcResponse {
  jsonrpc: '2.0';
  id: number | string | null;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
}

function ok(id: number | string | null, result: unknown): JsonRpcResponse {
  return { jsonrpc: '2.0', id, result };
}

function err(id: number | string | null, code: number, message: string): JsonRpcResponse {
  return { jsonrpc: '2.0', id, error: { code, message } };
}

// ---------------------------------------------------------------------------
// Request handlers
// ---------------------------------------------------------------------------

async function handleRequest(req: JsonRpcRequest): Promise<JsonRpcResponse> {
  const { id, method, params } = req;

  switch (method) {
    case 'initialize': {
      return ok(id, {
        protocolVersion: '2024-11-05',
        capabilities: { tools: {} },
        serverInfo: { name: 'cleo-mcp-adapter', version: '2026.4.132' },
      });
    }

    case 'tools/list': {
      return ok(id, { tools: ALL_TOOLS });
    }

    case 'tools/call': {
      const p = params as { name: string; arguments?: Record<string, string> };
      const toolName = p?.name;
      const toolInput = p?.arguments ?? {};

      if (!toolName) {
        return err(id, -32602, 'Missing tool name in params.name');
      }

      let result: McpToolResult;
      try {
        result = await handleToolCall(toolName, toolInput);
      } catch (e) {
        return err(id, -32603, `Tool execution failed: ${String(e)}`);
      }

      return ok(id, result);
    }

    case 'notifications/initialized':
    case 'ping': {
      return ok(id, {});
    }

    default:
      return err(id, -32601, `Method not found: ${method}`);
  }
}

// ---------------------------------------------------------------------------
// Server entry point
// ---------------------------------------------------------------------------

/**
 * Start the MCP stdio server.
 *
 * Reads newline-delimited JSON-RPC requests from stdin and writes responses
 * to stdout.  Each line must be a complete JSON-RPC 2.0 request object.
 *
 * @param opts.cwd - Working directory for CLI subprocess calls (defaults to `process.cwd()`).
 */
export function startServer(opts?: { cwd?: string }): void {
  void opts; // currently unused but preserved for future projectRoot injection

  const rl = readline.createInterface({
    input: process.stdin,
    terminal: false,
  });

  rl.on('line', (line) => {
    const trimmed = line.trim();
    if (!trimmed) return;

    let req: JsonRpcRequest;
    try {
      req = JSON.parse(trimmed) as JsonRpcRequest;
    } catch {
      const response = err(null, -32700, 'Parse error: invalid JSON');
      process.stdout.write(JSON.stringify(response) + '\n');
      return;
    }

    handleRequest(req)
      .then((response) => {
        process.stdout.write(JSON.stringify(response) + '\n');
      })
      .catch((e: unknown) => {
        const response = err(req.id ?? null, -32603, `Internal error: ${String(e)}`);
        process.stdout.write(JSON.stringify(response) + '\n');
      });
  });

  rl.on('close', () => {
    process.exit(0);
  });
}
