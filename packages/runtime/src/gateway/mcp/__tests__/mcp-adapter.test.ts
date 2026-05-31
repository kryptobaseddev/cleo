/**
 * MCP transport adapter tests (R3-T4 · T11448).
 *
 * Asserts:
 *  1. tools/list is generated from OPERATIONS behind the default-deny
 *     `mcpExposed` flag, and the exposed tool SET is identical to the legacy
 *     standalone `@cleocode/mcp-adapter` (the 3 sentient tools — no behavior
 *     change).
 *  2. tool-name <-> operation mapping is bijective over the exposed set and
 *     reproduces the historical `cleo_<domain>_<operation>` names exactly.
 *  3. tools/call maps `{ name, arguments }` → a `source: 'mcp'` DispatchRequest
 *     routed through the injected GatewayHandler, returning the LAFS envelope as
 *     the MCP tool result.
 *  4. unknown tool names render as MCP error results, never `process.exit`.
 *
 * The core logger factory is mocked so the adapter can be exercised without
 * initializing the real pino transport.
 *
 * @task T11448
 * @epic T11254
 * @saga T11243
 */

import type { DispatchRequest, DispatchResponse } from '@cleocode/contracts/gateway';
import { describe, expect, it, vi } from 'vitest';
import type { GatewayHandler } from '../../index.js';

vi.mock('@cleocode/core', () => ({
  getLogger: () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
}));

const { buildToolsList, exposedOperations } = await import('../tools-list.js');
const { toolNameToOperationKey, operationToToolName } = await import('../tool-naming.js');
const { callTool } = await import('../server.js');

/** The frozen historical MCP tool surface from the standalone adapter. */
const LEGACY_TOOL_NAMES = [
  'cleo_sentient_status',
  'cleo_sentient_propose_list',
  'cleo_sentient_propose_enable',
] as const;

describe('R3-T4 MCP tools/list — default-deny mcpExposed generation', () => {
  it('exposes ONLY operations that opt in via mcpExposed: true', () => {
    for (const op of exposedOperations()) {
      expect(op.mcpExposed).toBe(true);
    }
  });

  it('generated tool SET is identical to the legacy standalone adapter (no behavior change)', () => {
    const names = buildToolsList()
      .map((t) => t.name)
      .sort();
    expect(names).toEqual([...LEGACY_TOOL_NAMES].sort());
  });

  it('each tool carries a description + an object inputSchema', () => {
    for (const tool of buildToolsList()) {
      expect(tool.description.length).toBeGreaterThan(0);
      expect(tool.inputSchema.type).toBe('object');
      expect(typeof tool.inputSchema.properties).toBe('object');
    }
  });

  it('propose.list surfaces its `limit` param in the inputSchema', () => {
    const tool = buildToolsList().find((t) => t.name === 'cleo_sentient_propose_list');
    expect(tool?.inputSchema.properties.limit).toBeDefined();
  });
});

describe('R3-T4 MCP tool-name mapping', () => {
  it('round-trips every exposed op name → key → op', () => {
    const exposed = exposedOperations();
    for (const op of exposed) {
      const name = operationToToolName(op);
      const key = toolNameToOperationKey(name, exposed);
      expect(key).toEqual({ domain: op.domain, operation: op.operation });
    }
  });

  it('reproduces the historical names exactly', () => {
    expect(operationToToolName({ domain: 'sentient', operation: 'status' })).toBe(
      'cleo_sentient_status',
    );
    expect(operationToToolName({ domain: 'sentient', operation: 'propose.list' })).toBe(
      'cleo_sentient_propose_list',
    );
    expect(operationToToolName({ domain: 'sentient', operation: 'propose.enable' })).toBe(
      'cleo_sentient_propose_enable',
    );
  });

  it('rejects an unknown tool name', () => {
    expect(toolNameToOperationKey('cleo_unknown_tool', exposedOperations())).toBeUndefined();
  });
});

describe('R3-T4 MCP tools/call — gateway routing', () => {
  /** A fake gateway handler that records the request and echoes a success envelope. */
  function fakeHandler(): { handler: GatewayHandler; calls: DispatchRequest[] } {
    const calls: DispatchRequest[] = [];
    const handler: GatewayHandler = {
      handle(req: DispatchRequest): Promise<DispatchResponse> {
        calls.push(req);
        return Promise.resolve({
          meta: {
            gateway: req.gateway,
            domain: req.domain,
            operation: req.operation,
            timestamp: '2026-05-31T00:00:00.000Z',
            duration_ms: 1,
            source: req.source,
            requestId: req.requestId,
          },
          success: true,
          data: { ok: true },
        });
      },
    };
    return { handler, calls };
  }

  it('maps tools/call → source:mcp DispatchRequest through the handler', async () => {
    const { handler, calls } = fakeHandler();
    const result = await callTool(handler, 'cleo_sentient_propose_list', { limit: 5 });

    expect(calls).toHaveLength(1);
    expect(calls[0].source).toBe('mcp');
    expect(calls[0].gateway).toBe('query');
    expect(calls[0].domain).toBe('sentient');
    expect(calls[0].operation).toBe('propose.list');
    expect(calls[0].params).toEqual({ limit: 5 });
    expect(result.isError).toBeUndefined();
    // The LAFS envelope is serialized as the text content.
    const payload = JSON.parse(result.content[0].text) as DispatchResponse;
    expect(payload.success).toBe(true);
  });

  it('routes a mutate tool with the correct gateway', async () => {
    const { handler, calls } = fakeHandler();
    await callTool(handler, 'cleo_sentient_propose_enable', {});
    expect(calls[0].gateway).toBe('mutate');
    expect(calls[0].operation).toBe('propose.enable');
  });

  it('renders an unknown tool as an MCP error result (no process.exit)', async () => {
    const { handler, calls } = fakeHandler();
    const result = await callTool(handler, 'cleo_not_a_tool', {});
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('Unknown tool');
    expect(calls).toHaveLength(0);
  });

  it('surfaces a thrown handler error as an MCP error result', async () => {
    const handler: GatewayHandler = {
      handle: () => Promise.reject(new Error('boom')),
    };
    const result = await callTool(handler, 'cleo_sentient_status', {});
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('boom');
  });
});
