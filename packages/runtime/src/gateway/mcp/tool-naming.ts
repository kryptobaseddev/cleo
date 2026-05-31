/**
 * MCP tool-name <-> gateway-operation mapping.
 *
 * The MCP wire protocol identifies a tool by a single flat `name` string
 * (snake_case, e.g. `cleo_sentient_propose_list`), whereas the gateway routes
 * on a `(gateway, domain, operation)` triple (e.g.
 * `query / sentient / propose.list`). This module is the bijective bridge
 * between the two surfaces:
 *
 *   gateway op  →  MCP tool name   {@link operationToToolName}
 *   MCP tool name  →  domain+operation   {@link toolNameToOperationKey}
 *
 * ## Naming convention (frozen — matches the legacy `@cleocode/mcp-adapter`)
 *
 * `cleo_<domain>_<operation>` where every `.` and `-` in the dotted operation
 * name becomes `_`. The three historically-exposed tools therefore map as:
 *
 *   | gateway op                  | MCP tool name                  |
 *   |-----------------------------|--------------------------------|
 *   | `sentient` · `status`       | `cleo_sentient_status`         |
 *   | `sentient` · `propose.list` | `cleo_sentient_propose_list`   |
 *   | `sentient` · `propose.enable` | `cleo_sentient_propose_enable` |
 *
 * Preserving this exact mapping is what guarantees R3-T4's "no behavior change
 * to the MCP tool surface" acceptance criterion.
 *
 * @task T11448
 * @epic T11254
 * @saga T11243
 */

import type { OperationDef } from '@cleocode/contracts';

/** Prefix every CLEO MCP tool name carries. */
export const MCP_TOOL_PREFIX = 'cleo_';

/**
 * Identifies a gateway operation by its `(domain, operation)` pair. The CQRS
 * gateway resolves which `Gateway` ('query' | 'mutate') the pair belongs to via
 * the operation registry, so the MCP adapter does not need to carry it.
 */
export interface GatewayOperationKey {
  /** Canonical domain (e.g. `'sentient'`). */
  readonly domain: string;
  /** Dotted operation name (e.g. `'propose.list'`). */
  readonly operation: string;
}

/**
 * Convert a dotted operation segment into its MCP-safe snake_case form.
 *
 * @param segment - A domain or operation string (may contain `.`/`-`).
 * @returns The segment with every `.`/`-` replaced by `_`.
 */
function toSnake(segment: string): string {
  return segment.replace(/[.-]/g, '_');
}

/**
 * Derive the flat MCP tool name for a gateway operation.
 *
 * @param op - An {@link OperationDef} (or any object carrying `domain` +
 *   `operation`) from the registry.
 * @returns The MCP tool name, e.g. `'cleo_sentient_propose_list'`.
 */
export function operationToToolName(op: Pick<OperationDef, 'domain' | 'operation'>): string {
  return `${MCP_TOOL_PREFIX}${toSnake(op.domain)}_${toSnake(op.operation)}`;
}

/**
 * Resolve an MCP tool name back to its `(domain, operation)` gateway key.
 *
 * The reverse of {@link operationToToolName} cannot recover dots vs dashes from
 * the snake_case wire form, so resolution is performed against the provided
 * `exposed` set (the same `mcpExposed: true` subset used to build `tools/list`).
 * This keeps the mapping exact and rejects unknown tool names.
 *
 * @param toolName - The MCP `tools/call` tool name.
 * @param exposed - The exposed operation defs (the `mcpExposed` subset).
 * @returns The matching {@link GatewayOperationKey}, or `undefined` when the
 *   tool name does not correspond to any exposed operation.
 */
export function toolNameToOperationKey(
  toolName: string,
  exposed: readonly OperationDef[],
): GatewayOperationKey | undefined {
  const match = exposed.find((op) => operationToToolName(op) === toolName);
  return match ? { domain: match.domain, operation: match.operation } : undefined;
}
