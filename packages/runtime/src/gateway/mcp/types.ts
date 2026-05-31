/**
 * MCP wire types for the `@cleocode/runtime/gateway/mcp` transport adapter.
 *
 * A deliberately-minimal subset of the Model Context Protocol shapes the
 * adapter needs — no external MCP SDK dependency. Mirrors the legacy
 * `@cleocode/mcp-adapter` `types.ts` so the wire surface is unchanged.
 *
 * @task T11448
 * @epic T11254
 * @saga T11243
 */

/** JSON Schema property descriptor surfaced for a single tool input field. */
export interface McpInputProperty {
  /** JSON Schema primitive type (`'string'`, `'number'`, …). */
  type: string;
  /** Human-readable description shown in MCP clients. */
  description: string;
  /** Allowed values (JSON Schema `enum`) for finite-domain string params. */
  enum?: readonly string[];
}

/**
 * MCP tool definition shape (minimal — no external MCP SDK dependency).
 * Structurally compatible with the legacy `@cleocode/mcp-adapter` `McpTool`.
 */
export interface McpTool {
  /** Stable tool name (snake_case, e.g. `cleo_sentient_status`). */
  name: string;
  /** Human-readable description shown in MCP clients. */
  description: string;
  /** JSON Schema for the tool's input parameters. */
  inputSchema: {
    type: 'object';
    properties: Record<string, McpInputProperty>;
    required?: string[];
  };
}

/** A single content block returned by a tool handler. */
export interface McpContent {
  type: 'text';
  text: string;
}

/** Result returned by a tool handler over the MCP wire. */
export interface McpToolResult {
  content: McpContent[];
  isError?: boolean;
}
