/**
 * Type definitions for the CLEO MCP Adapter.
 *
 * The MCP Adapter is an EXTERNAL-ONLY stub that exposes a subset of CLEO
 * sentient operations as MCP (Model Context Protocol) tools.  It does NOT
 * wire into the internal CLEO dispatch layer — it communicates with CLEO
 * exclusively via CLI subprocess calls.
 *
 * @task T1148 W8-9
 */

/** Result of a CLI subprocess invocation. */
export interface CliResult {
  /** Whether the subprocess exited with code 0. */
  success: boolean;
  /** Raw stdout from the subprocess. */
  stdout: string;
  /** Raw stderr from the subprocess (non-empty on failure). */
  stderr: string;
  /** Exit code of the subprocess. */
  exitCode: number;
}

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
