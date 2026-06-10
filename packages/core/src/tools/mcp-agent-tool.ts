/**
 * Native MCP client (fan-IN) agent tool — connect-time `listTools` → register each
 * remote tool into the {@link ./agent-registry.js | AgentToolRegistry}
 * (T11948 · M7 · epic T11456 · SG-TOOLS · satisfies T11593 EP-MCP-HOST-FANIN + T1746).
 *
 * Where the runtime gateway is the MCP *server* (fan-OUT: it EXPOSES cleo ops as
 * MCP tools), this is the MCP *client* (fan-IN: it CONNECTS to an external MCP
 * server and PULLS its tools into cleo's own agent loop). On connect the client
 * performs the MCP handshake (`initialize` → `tools/list`) and registers EACH
 * remote tool as a proxy {@link AgentToolDescriptor} BEFORE the registry is frozen
 * (init-time fan-in). Each proxy tool's `execute` issues a `tools/call` over the
 * SAME transport and formats the result for the loop; a transport failure becomes a
 * typed result (the executable NEVER throws — the frozen ToolDispatchEngine is
 * unchanged).
 *
 * This REPLACES the external mcp-tool dependency for the host-loop path. It is a
 * deliberately-minimal native client — NO external MCP SDK dependency: the wire is
 * the standard MCP JSON-RPC ({@link McpTransport}), with stdio / SSE / HTTP
 * transports as concrete {@link McpTransport} implementations. Placed in `core` per
 * the package boundary (consumed by the harness, never redefined there — Gate-11).
 *
 * ## Availability (AC — live-connection only)
 *
 * A fan-in tool is available ONLY while its MCP server connection is live. The
 * client exposes an {@link McpConnection.isLive} cell that each proxy tool's
 * {@link AvailabilityCheck} reads; once the connection closes (or its transport
 * errors fatally), the proxy tools report unavailable rather than dispatching into
 * a dead transport.
 *
 * ## Gate-13
 *
 * No model/transport/provider LLM client is constructed here — the MCP transport
 * speaks the tool protocol, not an LLM wire. There is no chokepoint concern.
 *
 * @epic T11456
 * @task T11948
 * @see ../../runtime/src/gateway/mcp/types.ts — the MCP server (fan-out) wire types this mirrors
 * @see ./exec-code-agent-tool.js — the injectable-seam + self-registering-marker pattern mirrored here
 */

import { z } from 'zod';
import { getLogger } from '../logger.js';
import type {
  AgentToolDescriptor,
  AgentToolRegistry,
  AvailabilityCheck,
} from './agent-registry.js';

const log = getLogger('tool-mcp-client');

/** JSON Schema property descriptor for a single remote-tool input field. */
export interface McpInputProperty {
  /** JSON Schema primitive type (`'string'`, `'number'`, …). */
  readonly type: string;
  /** Human-readable description. */
  readonly description?: string;
  /** Allowed values (JSON Schema `enum`). */
  readonly enum?: readonly string[];
}

/**
 * MCP remote-tool definition (minimal subset — no external MCP SDK dependency).
 * The shape returned by an MCP server's `tools/list`.
 */
export interface McpRemoteTool {
  /** Stable remote tool name. */
  readonly name: string;
  /** Human-readable description. */
  readonly description?: string;
  /** JSON Schema for the tool's input parameters. */
  readonly inputSchema?: {
    readonly type?: string;
    readonly properties?: Readonly<Record<string, McpInputProperty>>;
    readonly required?: readonly string[];
  };
}

/** A single content block returned by an MCP `tools/call`. */
export interface McpContent {
  readonly type: string;
  readonly text?: string;
}

/** Result returned by an MCP `tools/call`. */
export interface McpToolCallResult {
  readonly content?: readonly McpContent[];
  readonly isError?: boolean;
}

/**
 * The wire seam every MCP transport implements: issue a JSON-RPC `method` with
 * `params` and resolve the typed `result`. The stdio / SSE / HTTP transports are
 * concrete implementations; the unit test injects an in-memory fake. The transport
 * owns framing + correlation — this module only speaks MCP methods over it.
 */
export interface McpTransport {
  /**
   * Send an MCP JSON-RPC request and resolve its `result`.
   *
   * @param method - The MCP method (`'initialize'`, `'tools/list'`, `'tools/call'`).
   * @param params - The method params.
   * @returns The JSON-RPC `result` payload.
   * @throws When the transport is dead or the server returns a JSON-RPC error.
   */
  request(method: string, params?: Readonly<Record<string, unknown>>): Promise<unknown>;
  /** Close the transport (idempotent). After close, {@link request} rejects. */
  close(): Promise<void>;
}

/** Transport kinds a native MCP client connection can speak over. */
export const MCP_TRANSPORT_KINDS = ['stdio', 'sse', 'http'] as const;

/** One supported {@link MCP_TRANSPORT_KINDS} value. */
export type McpTransportKind = (typeof MCP_TRANSPORT_KINDS)[number];

/**
 * A live MCP client connection: a transport + the liveness cell the proxy tools'
 * availability predicate reads. Produced by {@link connectMcpServer}.
 */
export interface McpConnection {
  /** A stable server name used to namespace the fan-in tool names. */
  readonly serverName: string;
  /** The underlying transport. */
  readonly transport: McpTransport;
  /** The remote tools discovered at connect (`tools/list`). */
  readonly tools: readonly McpRemoteTool[];
  /** `true` while the connection is live; flips `false` on {@link disconnect}. */
  isLive(): boolean;
  /** Close the transport and flip the liveness cell to `false`. */
  disconnect(): Promise<void>;
}

/**
 * Perform the MCP handshake over `transport` and discover its tools: send
 * `initialize`, then `tools/list`. Returns a live {@link McpConnection} whose
 * liveness cell is `true` until {@link McpConnection.disconnect}. The transport is
 * supplied by the caller (so stdio / SSE / HTTP — or an in-memory fake — all flow
 * through the same path).
 *
 * @param serverName - Stable name to namespace this server's fan-in tools.
 * @param transport - The MCP transport to handshake over.
 * @returns The connected {@link McpConnection}.
 * @throws When `initialize` or `tools/list` fails (the connection is not live).
 */
export async function connectMcpServer(
  serverName: string,
  transport: McpTransport,
): Promise<McpConnection> {
  await transport.request('initialize', {
    protocolVersion: '2025-06-18',
    capabilities: {},
    clientInfo: { name: 'cleo', version: '0' },
  });
  const listed = await transport.request('tools/list', {});
  const tools = extractRemoteTools(listed);

  let live = true;
  return {
    serverName,
    transport,
    tools,
    isLive: () => live,
    disconnect: async () => {
      live = false;
      try {
        await transport.close();
      } catch (err) {
        log.debug({ err, serverName }, 'mcp: transport close failed (ignored)');
      }
    },
  };
}

/** Narrow a `tools/list` result into an {@link McpRemoteTool}[] defensively. */
function extractRemoteTools(listed: unknown): McpRemoteTool[] {
  if (
    typeof listed === 'object' &&
    listed !== null &&
    'tools' in listed &&
    Array.isArray((listed as { tools: unknown }).tools)
  ) {
    return (listed as { tools: McpRemoteTool[] }).tools.filter(
      (t): t is McpRemoteTool => typeof t?.name === 'string',
    );
  }
  return [];
}

/**
 * The namespaced agent-tool name for a remote MCP tool: `mcp_<server>_<tool>`. So
 * two servers exposing a same-named tool never collide in the registry.
 *
 * @param serverName - The MCP server's stable name.
 * @param toolName - The remote tool's name.
 * @returns The namespaced, registry-unique tool name.
 */
export function mcpToolName(serverName: string, toolName: string): string {
  const safe = (s: string): string => s.replace(/[^a-zA-Z0-9_]/g, '_');
  return `mcp_${safe(serverName)}_${safe(toolName)}`;
}

/**
 * Build a Zod parameter schema from a remote tool's JSON Schema. The fan-in proxy
 * accepts an open object (the remote server is the source of truth for its own
 * validation); we surface declared properties as a permissive record so the model
 * sees the shape while the remote performs authoritative validation.
 *
 * @param tool - The remote tool definition.
 * @returns A Zod schema for the proxy's parameters.
 */
function remoteToolSchema(tool: McpRemoteTool): z.ZodType {
  const props = tool.inputSchema?.properties ?? {};
  const shape: Record<string, z.ZodTypeAny> = {};
  const required = new Set(tool.inputSchema?.required ?? []);
  for (const [key, prop] of Object.entries(props)) {
    let field: z.ZodTypeAny;
    switch (prop.type) {
      case 'number':
      case 'integer':
        field = z.number();
        break;
      case 'boolean':
        field = z.boolean();
        break;
      case 'array':
        field = z.array(z.unknown());
        break;
      case 'object':
        field = z.record(z.string(), z.unknown());
        break;
      default:
        field = z.string();
    }
    if (prop.description) field = field.describe(prop.description);
    shape[key] = required.has(key) ? field : field.optional();
  }
  return z.object(shape).passthrough();
}

/**
 * Build the proxy {@link AgentToolDescriptor} for ONE remote tool over a live
 * connection. Its `execute` issues `tools/call` over the connection's transport
 * and formats the result; a transport / server error becomes a typed result (never
 * throws). Its availability returns `true` only while the connection is live.
 *
 * @param conn - The live MCP connection.
 * @param tool - The remote tool to proxy.
 * @returns The proxy descriptor to register.
 */
export function buildMcpProxyTool(conn: McpConnection, tool: McpRemoteTool): AgentToolDescriptor {
  const liveOnly: AvailabilityCheck = () => conn.isLive();
  return {
    name: mcpToolName(conn.serverName, tool.name),
    // 'net' — the proxy reaches an external MCP server over its transport.
    class: 'net',
    description:
      tool.description ??
      `Proxy for remote MCP tool "${tool.name}" on server "${conn.serverName}".`,
    toolset: 'agent',
    stateless: false,
    available: liveOnly,
    parameters: remoteToolSchema(tool),
    execute: async (rawArgs): Promise<unknown> => {
      if (!conn.isLive()) {
        return {
          ok: false,
          error: {
            code: 'E_MCP_CONNECTION_DEAD',
            message: `MCP server "${conn.serverName}" connection is no longer live`,
          },
        };
      }
      try {
        const result = (await conn.transport.request('tools/call', {
          name: tool.name,
          arguments: rawArgs,
        })) as McpToolCallResult;
        const text = (result.content ?? [])
          .map((c) => c.text ?? '')
          .filter((t) => t.length > 0)
          .join('\n');
        return { ok: result.isError !== true, isError: result.isError === true, content: text };
      } catch (err) {
        // A transport / server error is a typed dispatch failure, never a throw.
        return {
          ok: false,
          error: {
            code: 'E_MCP_CALL_FAILED',
            message: err instanceof Error ? err.message : String(err),
          },
        };
      }
    },
  };
}

/**
 * Register every fan-in proxy tool for a live MCP connection into `registry`. Pure
 * registration over an ALREADY-connected {@link McpConnection} — the connect /
 * `tools/list` happened in {@link connectMcpServer} (which the host calls at
 * init-time, before the registry is frozen). Each remote tool becomes one proxy
 * descriptor (AC1); each is hidden once the connection drops (AC — live-only).
 *
 * @param registry - The registry to populate (must not yet be frozen).
 * @param conn - The live MCP connection whose tools to fan in.
 * @returns The registered proxy tool names.
 */
export function registerMcpConnectionTools(
  registry: AgentToolRegistry,
  conn: McpConnection,
): string[] {
  const names: string[] = [];
  for (const tool of conn.tools) {
    const descriptor = buildMcpProxyTool(conn, tool);
    registry.register(descriptor);
    names.push(descriptor.name);
  }
  return names;
}

/** Options for {@link registerMcpAgentTools} — the connections to fan in. */
export interface McpAgentToolOptions {
  /**
   * Already-connected MCP connections whose remote tools to fan in. The host
   * connects each server (via {@link connectMcpServer}) at init-time, BEFORE the
   * registry is frozen, then passes the live connections here. Defaults to none —
   * with no MCP servers configured this is a no-op (core runs MCP-OFF).
   */
  readonly connections?: readonly McpConnection[];
}

/**
 * Register the fan-in proxy tools for every supplied MCP connection. Pure
 * registration — no network handshake here (the connections are already live);
 * the connect happens earlier in {@link connectMcpServer}. With no connections
 * this is a no-op (the common no-MCP-configured case).
 *
 * @param registry - The registry to populate.
 * @param options - The live connections to fan in.
 */
export function registerMcpAgentTools(
  registry: AgentToolRegistry,
  options: McpAgentToolOptions = {},
): void {
  for (const conn of options.connections ?? []) {
    registerMcpConnectionTools(registry, conn);
  }
}

/**
 * Self-registration marker (AC1) — the identifier the
 * {@link AgentToolRegistry.discover} bounded source scan greps for. With no live
 * connections supplied this registers nothing (a host wires connections via
 * {@link registerMcpAgentTools} directly with its connected servers).
 *
 * @param registry - The registry to populate.
 */
export function registerAgentTools(registry: AgentToolRegistry): void {
  registerMcpAgentTools(registry);
}
