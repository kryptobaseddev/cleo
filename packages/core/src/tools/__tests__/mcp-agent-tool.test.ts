/**
 * Tests for the native MCP client (fan-IN) agent tool (T11948 · M7 · epic T11456).
 *
 * Uses an IN-MEMORY fake MCP server (an {@link McpTransport} that answers
 * `initialize` / `tools/list` / `tools/call` from a fixed tool set) — no real
 * stdio / SSE / HTTP transport, no external MCP server. Covers:
 *   - connect → `tools/list` → register each remote tool as a proxy
 *     AgentToolDescriptor (toolset 'agent') BEFORE the registry is frozen;
 *   - a proxy tool's execute proxies over the transport (`tools/call`) and formats
 *     the result;
 *   - a transport error becomes a TYPED dispatch failure (never throws);
 *   - availability: a fan-in tool is available only while the connection is live.
 *
 * @task T11948
 * @epic T11456
 */

import type { GuardedToolSurface } from '@cleocode/contracts/tools/skill-executor';
import { describe, expect, it } from 'vitest';
import { AgentToolRegistry } from '../agent-registry.js';
import {
  connectMcpServer,
  type McpTransport,
  mcpToolName,
  registerMcpConnectionTools,
} from '../mcp-agent-tool.js';

const noopSurface = {} as GuardedToolSurface;

/**
 * An in-memory fake MCP server transport. Answers the MCP handshake + a fixed tool
 * set; records `tools/call` invocations. `failCalls` makes `tools/call` reject so
 * the typed-failure path is exercised.
 */
function fakeTransport(opts: { failCalls?: boolean } = {}): {
  transport: McpTransport;
  callArgs: Array<{ name: string; arguments: unknown }>;
  closed: () => boolean;
} {
  const callArgs: Array<{ name: string; arguments: unknown }> = [];
  let closed = false;
  const transport: McpTransport = {
    request: async (method, params) => {
      if (closed) throw new Error('transport closed');
      if (method === 'initialize') return { protocolVersion: '2025-06-18' };
      if (method === 'tools/list') {
        return {
          tools: [
            {
              name: 'echo',
              description: 'Echo back text.',
              inputSchema: {
                type: 'object',
                properties: { text: { type: 'string', description: 'Text to echo.' } },
                required: ['text'],
              },
            },
          ],
        };
      }
      if (method === 'tools/call') {
        if (opts.failCalls) throw new Error('remote boom');
        callArgs.push(params as { name: string; arguments: unknown });
        const args = (params as { arguments: { text: string } }).arguments;
        return { content: [{ type: 'text', text: `echo: ${args.text}` }] };
      }
      throw new Error(`unexpected method ${method}`);
    },
    close: async () => {
      closed = true;
    },
  };
  return { transport, callArgs, closed: () => closed };
}

describe('mcp-agent-tool — connect-time fan-in', () => {
  it('connects, lists tools, and registers each remote tool as a proxy BEFORE freeze', async () => {
    const { transport } = fakeTransport();
    const conn = await connectMcpServer('demo', transport);
    expect(conn.tools.map((t) => t.name)).toEqual(['echo']);

    const registry = new AgentToolRegistry();
    const names = registerMcpConnectionTools(registry, conn);
    await registry.init({ skipBuiltins: true });

    const expectedName = mcpToolName('demo', 'echo');
    expect(names).toEqual([expectedName]);
    const tool = registry.get(expectedName);
    expect(tool?.toolset).toBe('agent');
    expect(tool?.class).toBe('net');
  });

  it("a proxy tool's execute proxies over the transport and formats the result", async () => {
    const { transport, callArgs } = fakeTransport();
    const conn = await connectMcpServer('demo', transport);
    const registry = new AgentToolRegistry();
    registerMcpConnectionTools(registry, conn);
    await registry.init({ skipBuiltins: true });

    const out = (await registry.getExecutable(mcpToolName('demo', 'echo'))?.(
      { text: 'hi' },
      noopSurface,
    )) as { ok: boolean; content: string };
    expect(callArgs).toEqual([{ name: 'echo', arguments: { text: 'hi' } }]);
    expect(out.ok).toBe(true);
    expect(out.content).toBe('echo: hi');
  });

  it('a transport error becomes a typed failure (never throws)', async () => {
    const { transport } = fakeTransport({ failCalls: true });
    const conn = await connectMcpServer('demo', transport);
    const registry = new AgentToolRegistry();
    registerMcpConnectionTools(registry, conn);
    await registry.init({ skipBuiltins: true });

    const out = (await registry.getExecutable(mcpToolName('demo', 'echo'))?.(
      { text: 'hi' },
      noopSurface,
    )) as { ok: boolean; error: { code: string } };
    expect(out.ok).toBe(false);
    expect(out.error.code).toBe('E_MCP_CALL_FAILED');
  });
});

describe('mcp-agent-tool — availability tracks the live connection', () => {
  it('a fan-in tool is available only while the connection is live', async () => {
    const { transport } = fakeTransport();
    const conn = await connectMcpServer('demo', transport);
    const registry = new AgentToolRegistry();
    registerMcpConnectionTools(registry, conn);
    await registry.init({ skipBuiltins: true });

    const name = mcpToolName('demo', 'echo');
    expect(registry.available({}).some((t) => t.name === name)).toBe(true);

    // Drop the connection — the proxy tool reports unavailable.
    await conn.disconnect();
    expect(conn.isLive()).toBe(false);
    expect(registry.available({}).some((t) => t.name === name)).toBe(false);

    // ... and a call into the dead connection is a typed failure, not a throw.
    const out = (await registry.getExecutable(name)?.({ text: 'hi' }, noopSurface)) as {
      ok: boolean;
      error: { code: string };
    };
    expect(out.ok).toBe(false);
    expect(out.error.code).toBe('E_MCP_CONNECTION_DEAD');
  });
});
