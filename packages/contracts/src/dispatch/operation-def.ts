/**
 * Dispatch operation-def contracts.
 *
 * Canonical home for the {@link OperationDef} and {@link Resolution}
 * interfaces that describe a single dispatchable CQRS operation and the
 * result of resolving one from the operation registry.
 *
 * Promoted to `@cleocode/contracts` in Phase 0b of the SG-ARCH-SOLID Saga
 * (T9831 · E-CONTRACTS-FOUNDATION T9832 · T9954). Originally defined in
 * `packages/cleo/src/dispatch/registry.ts` (lines 14-41 / 43-53). The
 * `packages/cleo` definition is now a re-export shim — every consumer of
 * `OperationDef` / `Resolution` continues to compile unchanged.
 *
 * This promotion unblocks E-CLI-BOUNDARY (T9833) — the registry data
 * relocation can now move {@link OPERATIONS} into `@cleocode/contracts`
 * (or split it without changing the type's canonical home) without
 * crossing a circular dependency.
 *
 * NOT promoted (intentional — different concern):
 *   - `OPERATIONS: OperationDef[]` — the registry data itself remains in
 *     `packages/cleo/src/dispatch/registry.ts` and is the subject of the
 *     follow-up E-CLI-BOUNDARY epic.
 *   - The helper functions (`resolve`, `validateRequiredParams`,
 *     `getByDomain`, `getByGateway`, `getByTier`, `getActiveDomains`,
 *     `getCounts`, `deriveGatewayMatrix`, `getGatewayDomains`) — they
 *     operate on the data and remain colocated with it.
 *
 * @since SG-ARCH-SOLID Saga T9831 · E-CONTRACTS-FOUNDATION T9832 · T9954 (Phase 0b)
 */

import type { ParamDef } from '../operations/params.js';
import type { CanonicalDomain, Gateway, Tier } from './identity.js';

// Re-export the upstream identity types so consumers can pull every
// dispatch-related shape from a single subpath without having to know
// which leaf file each type lives in.
export type { CanonicalDomain, Gateway, ParamDef, Tier };

// ── OperationDef ─────────────────────────────────────────────────────

/**
 * Definition of a single dispatchable operation.
 *
 * Each entry in the operation registry (currently in
 * `packages/cleo/src/dispatch/registry.ts`'s `OPERATIONS` array)
 * conforms to this interface. The dispatcher uses these definitions to
 * (1) route a {@link CanonicalDomain} + operation-name + {@link Gateway}
 * triple to its handler, (2) validate that all required parameters are
 * present, and (3) emit dispatch-validation telemetry.
 *
 * Originally defined in `packages/cleo/src/dispatch/registry.ts:14-41`.
 *
 * @since SG-ARCH-SOLID Saga T9831 · E-CONTRACTS-FOUNDATION T9832 · T9954 (Phase 0b)
 */
export interface OperationDef {
  /** The CQRS gateway ('query' or 'mutate'). */
  gateway: Gateway;
  /** The canonical domain this operation belongs to. */
  domain: CanonicalDomain;
  /** The specific operation name (e.g. 'show', 'skill.list'). */
  operation: string;
  /** Brief description of what the operation does. */
  description: string;
  /** Agent progressive-disclosure tier (0=basic, 1=memory/check, 2=full). */
  tier: Tier;
  /** Whether the operation is safe to retry. */
  idempotent: boolean;
  /** Whether this operation requires an active session. */
  sessionRequired: boolean;
  /** List of parameter keys that MUST be present in the request. */
  requiredParams: string[];
  /**
   * Fully-described parameter list. Replaces `requiredParams` when populated.
   * Empty array = "no declared params" (not "no params accepted").
   * Optional during T4897 migration — defaults to [] when absent.
   * @see T4897 for progressive migration
   */
  params?: ParamDef[];
  /**
   * Whether this operation is surfaced as an MCP tool by the
   * `@cleocode/runtime/gateway/mcp` transport adapter.
   *
   * **Default-deny**: absent / `false` means the operation is NOT exposed over
   * MCP. The MCP adapter generates its `tools/list` from the subset of
   * {@link OperationDef} entries that explicitly set `mcpExposed: true`, so the
   * external tool surface is opt-in rather than the full CQRS registry. This
   * preserves the historically-curated MCP surface (the standalone
   * `@cleocode/mcp-adapter` exposed exactly 3 sentient tools) while letting new
   * tools be promoted one registry edit at a time.
   *
   * @see {@link https://modelcontextprotocol.io | Model Context Protocol}
   * @task T11448
   */
  mcpExposed?: boolean;
}

// ── Resolution ───────────────────────────────────────────────────────

/**
 * Resolution output for a dispatch request.
 *
 * Returned by the `resolve(gateway, domain, operation)` helper in the
 * operation registry. Bundles the resolved {@link OperationDef} with the
 * already-typed `domain` + `operation` strings so downstream consumers
 * don't have to re-narrow them.
 *
 * Originally defined in `packages/cleo/src/dispatch/registry.ts:43-53`.
 *
 * @since SG-ARCH-SOLID Saga T9831 · E-CONTRACTS-FOUNDATION T9832 · T9954 (Phase 0b)
 */
export interface Resolution {
  /** The canonical domain. */
  domain: CanonicalDomain;
  /** The operation name. */
  operation: string;
  /** The definition of the matched operation. */
  def: OperationDef;
}
