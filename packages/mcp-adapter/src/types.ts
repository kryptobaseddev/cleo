/**
 * Type definitions for the CLEO MCP Adapter.
 *
 * The MCP Adapter exposes a subset of CLEO sentient operations as MCP
 * (Model Context Protocol) tools. It communicates with CLEO via the
 * `@cleocode/core` SDK directly — no CLI subprocess.
 *
 * @task T1485 — MCP adapter SDK migration (T948 prerequisite)
 */

/** MCP tool definition shape (minimal — no external MCP SDK dependency). */
export interface McpTool {
  /** Stable tool name (snake_case). */
  name: string;
  /** Human-readable description shown in MCP clients. */
  description: string;
  /** JSON Schema for the tool's input parameters. */
  inputSchema: {
    type: 'object';
    properties: Record<string, { type: string; description: string }>;
    required?: string[];
  };
}

/** MCP content block returned by tool handlers. */
export interface McpContent {
  type: 'text';
  text: string;
}

/** Result returned by a tool handler. */
export interface McpToolResult {
  content: McpContent[];
  isError?: boolean;
}
