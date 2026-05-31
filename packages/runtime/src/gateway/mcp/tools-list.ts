/**
 * MCP `tools/list` generation from the OPERATIONS registry.
 *
 * The MCP tool surface is **default-deny**: only {@link OperationDef} entries
 * that explicitly set `mcpExposed: true` are surfaced. This replaces the legacy
 * `@cleocode/mcp-adapter`'s hand-maintained `ALL_TOOLS` array with a single
 * generation point driven by the canonical registry — promoting a new tool is
 * now one `mcpExposed: true` edit in `@cleocode/contracts`, not a fork-and-copy
 * into a standalone adapter.
 *
 * @task T11448
 * @epic T11254
 * @saga T11243
 */

import type { OperationDef, ParamDef } from '@cleocode/contracts';
import { OPERATIONS } from '../registry.js';
import { operationToToolName } from './tool-naming.js';
import type { McpInputProperty, McpTool } from './types.js';

/**
 * The subset of OPERATIONS surfaced over MCP (default-deny `mcpExposed` filter).
 *
 * @returns Every {@link OperationDef} with `mcpExposed === true`, in registry
 *   order. Empty when no operation opts in.
 */
export function exposedOperations(): OperationDef[] {
  return OPERATIONS.filter((op) => op.mcpExposed === true);
}

/**
 * Map a JSON-ish {@link ParamDef} type to its JSON Schema primitive.
 *
 * MCP clients consume standard JSON Schema, so `'array'` widens to `'string'`
 * the same way the CLI's citty bridge does (callers split/parse) and every
 * other type passes through unchanged.
 *
 * @param type - The {@link ParamDef} runtime type.
 * @returns The JSON Schema `type` keyword.
 */
function paramTypeToJsonSchema(type: ParamDef['type']): string {
  return type === 'array' ? 'string' : type;
}

/**
 * Build the MCP `inputSchema` for a single operation from its `params`.
 *
 * Hidden params (`hidden: true`) are excluded from the public tool surface,
 * matching the JSON Schema generation policy declared on {@link ParamDef}.
 *
 * @param op - The exposed operation definition.
 * @returns A JSON Schema object describing the tool's input.
 */
function buildInputSchema(op: OperationDef): McpTool['inputSchema'] {
  const properties: Record<string, McpInputProperty> = {};
  const required: string[] = [];

  for (const param of op.params ?? []) {
    if (param.hidden === true) continue;
    const prop: McpInputProperty = {
      type: paramTypeToJsonSchema(param.type),
      description: param.description,
    };
    if (param.enum !== undefined && param.enum.length > 0) {
      prop.enum = param.enum;
    }
    properties[param.name] = prop;
    if (param.required) required.push(param.name);
  }

  const schema: McpTool['inputSchema'] = { type: 'object', properties };
  if (required.length > 0) schema.required = required;
  return schema;
}

/**
 * Convert a single exposed {@link OperationDef} into its MCP tool definition.
 *
 * @param op - An operation with `mcpExposed === true`.
 * @returns The MCP {@link McpTool} (name + description + inputSchema).
 */
export function operationToMcpTool(op: OperationDef): McpTool {
  return {
    name: operationToToolName(op),
    description: op.description,
    inputSchema: buildInputSchema(op),
  };
}

/**
 * Generate the full MCP `tools/list` payload from the registry.
 *
 * @returns Every exposed operation rendered as an {@link McpTool}, in registry
 *   order (stable across calls).
 */
export function buildToolsList(): McpTool[] {
  return exposedOperations().map(operationToMcpTool);
}
