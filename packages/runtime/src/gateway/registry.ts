/**
 * Unified CQRS Dispatch Layer -- Operation Registry (shim)
 *
 * The `OPERATIONS` data array was relocated to
 * `@cleocode/contracts/dispatch/operations-registry` in T10061 / T9833b
 * (E-CLI-BOUNDARY · Saga T9831 SG-ARCH-SOLID). This file is now a thin
 * re-export shim that:
 *
 *   1. Re-exports `OPERATIONS` from contracts so every downstream consumer
 *      that already imports `{ OPERATIONS }` from this path continues to
 *      compile unchanged.
 *   2. Keeps the pure utility / derivation functions (`resolve`,
 *      `validateRequiredParams`, `getByDomain`, etc.) that operate on
 *      the data and are rightly colocated with the CLI package.
 *
 * @epic T4820
 * @task T4814, T5241, T5615, T10061
 */

// OperationDef + Resolution live in @cleocode/contracts (SSoT — promoted in
// T9954 / Phase 0b of SG-ARCH-SOLID Saga T9831 · E-CONTRACTS-FOUNDATION
// T9832). Imported below for internal use AND re-exported so that every
// downstream consumer that already imports from './registry.js' continues
// to compile unchanged.
import type { OperationDef, Resolution } from '@cleocode/contracts';
import { OPERATIONS as _OPERATIONS } from '@cleocode/contracts';
import type { CanonicalDomain, Gateway, Tier } from '@cleocode/contracts/gateway';

export type { OperationDef, Resolution };

/** The single source of truth for all operations in CLEO (data lives in @cleocode/contracts). */
export const OPERATIONS: OperationDef[] = _OPERATIONS;

// ---------------------------------------------------------------------------
// Gateway Matrix Derivation
// ---------------------------------------------------------------------------

/**
 * Derive a gateway operation matrix from the registry.
 *
 * Returns `Record<string, string[]>` containing:
 * - All canonical domains with their operations
 *
 * This is the SINGLE derivation point — gateways use this instead of
 * maintaining independent operation lists.
 */
export function deriveGatewayMatrix(gateway: Gateway): Record<string, string[]> {
  const matrix: Record<string, string[]> = {};

  for (const op of OPERATIONS) {
    if (op.gateway !== gateway) continue;
    if (!matrix[op.domain]) matrix[op.domain] = [];
    matrix[op.domain].push(op.operation);
  }

  return matrix;
}

/**
 * Get all accepted domain names for a gateway (canonical only).
 */
export function getGatewayDomains(gateway: Gateway): string[] {
  return Object.keys(deriveGatewayMatrix(gateway));
}

// ---------------------------------------------------------------------------
// Lookup & Validation
// ---------------------------------------------------------------------------

/**
 * Resolves a domain + operation to its registered definition.
 */
export function resolve(
  gateway: Gateway,
  domain: string,
  operation: string,
): Resolution | undefined {
  const def = OPERATIONS.find(
    (o) => o.gateway === gateway && o.domain === domain && o.operation === operation,
  );

  if (!def) return undefined;

  return { domain: def.domain, operation: def.operation, def };
}

/**
 * Validates that all required parameters are present in the request.
 * Returns an array of missing parameter keys.
 */
export function validateRequiredParams(
  def: OperationDef,
  params?: Record<string, unknown>,
): string[] {
  if (!def.requiredParams || def.requiredParams.length === 0) return [];
  const provided = params || {};
  // Build a quick lookup so we can honor per-param `allowEmpty` declarations.
  // When a ParamDef sets `allowEmpty: true`, the empty string `""` is a
  // valid value rather than "missing" — e.g. `provenance.backfill --since ""`
  // walks every reachable tag from the beginning of history.
  const allowEmptyKeys = new Set<string>();
  if (def.params) {
    for (const p of def.params) {
      if (p.allowEmpty === true) allowEmptyKeys.add(p.name);
    }
  }
  return def.requiredParams.filter((key) => {
    const v = provided[key];
    if (v === undefined || v === null) return true;
    if (v === '' && !allowEmptyKeys.has(key)) return true;
    return false;
  });
}

/** Get all operations for a specific canonical domain. */
export function getByDomain(domain: CanonicalDomain): OperationDef[] {
  return OPERATIONS.filter((o) => o.domain === domain);
}

/** Get all operations for a specific gateway. */
export function getByGateway(gateway: Gateway): OperationDef[] {
  return OPERATIONS.filter((o) => o.gateway === gateway);
}

/** Get all operations available at or below a specific tier. */
export function getByTier(tier: Tier): OperationDef[] {
  return OPERATIONS.filter((o) => o.tier <= tier);
}

/** Get a list of canonical domains that actually have operations registered. */
export function getActiveDomains(): CanonicalDomain[] {
  const active = new Set(OPERATIONS.map((o) => o.domain));
  return Array.from(active);
}

/**
 * Returns summary counts of operations for module validation.
 */
export function getCounts(): { query: number; mutate: number; total: number } {
  return {
    query: OPERATIONS.filter((o) => o.gateway === 'query').length,
    mutate: OPERATIONS.filter((o) => o.gateway === 'mutate').length,
    total: OPERATIONS.length,
  };
}

// Module load validation (dynamic, no hardcoded operation totals)
const counts = getCounts();
if (counts.total !== OPERATIONS.length) {
  console.warn(
    `[Registry] Operation count mismatch: total=${counts.total}, registry=${OPERATIONS.length}`,
  );
}
