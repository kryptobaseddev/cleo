/**
 * Registry-Gateway Sync Test
 *
 * Ensures the dispatch registry (OPERATIONS array) stays in sync with the
 * MCP gateway operation matrices (QUERY_OPERATIONS, MUTATE_OPERATIONS).
 *
 * Prevents drift between the two sources of truth.
 */

import { describe, it, expect } from 'vitest';
import { QUERY_OPERATIONS } from '../../mcp/gateways/query.js';
import { MUTATE_OPERATIONS } from '../../mcp/gateways/mutate.js';
import { OPERATIONS } from '../registry.js';
import type { Gateway } from '../types.js';

const CANONICAL_DOMAINS = [
  'tasks', 'session', 'memory', 'check', 'pipeline',
  'orchestrate', 'tools', 'admin', 'nexus', 'sharing',
] as const;

const LEGACY_ALIAS_DOMAINS = [
  'research', 'lifecycle', 'validate', 'release',
  'system', 'issues', 'skills', 'providers',
] as const;

/**
 * Extract canonical-domain-only entries from a gateway operation matrix.
 * Returns an array of { domain, operation } pairs.
 */
function extractCanonicalOps(
  matrix: Record<string, string[]>,
): Array<{ domain: string; operation: string }> {
  const legacySet = new Set<string>(LEGACY_ALIAS_DOMAINS);
  const ops: Array<{ domain: string; operation: string }> = [];
  for (const [domain, operations] of Object.entries(matrix)) {
    if (legacySet.has(domain)) continue;
    for (const operation of operations) {
      ops.push({ domain, operation });
    }
  }
  return ops;
}

describe('Registry-Gateway Sync', () => {
  const canonicalQueryOps = extractCanonicalOps(QUERY_OPERATIONS);
  const canonicalMutateOps = extractCanonicalOps(MUTATE_OPERATIONS);

  describe('every canonical gateway query operation exists in registry', () => {
    for (const { domain, operation } of canonicalQueryOps) {
      it(`query ${domain}.${operation} exists in registry`, () => {
        const match = OPERATIONS.find(
          (def) =>
            def.gateway === 'query' &&
            def.domain === domain &&
            def.operation === operation,
        );
        expect(
          match,
          `Missing from registry: query ${domain}.${operation}`,
        ).toBeDefined();
      });
    }
  });

  describe('every canonical gateway mutate operation exists in registry', () => {
    for (const { domain, operation } of canonicalMutateOps) {
      it(`mutate ${domain}.${operation} exists in registry`, () => {
        const match = OPERATIONS.find(
          (def) =>
            def.gateway === 'mutate' &&
            def.domain === domain &&
            def.operation === operation,
        );
        expect(
          match,
          `Missing from registry: mutate ${domain}.${operation}`,
        ).toBeDefined();
      });
    }
  });

  describe('every registry operation exists in canonical gateways', () => {
    const queryGwSet = new Set(
      canonicalQueryOps.map((o) => `${o.domain}.${o.operation}`),
    );
    const mutateGwSet = new Set(
      canonicalMutateOps.map((o) => `${o.domain}.${o.operation}`),
    );

    for (const def of OPERATIONS) {
      it(`registry ${def.gateway} ${def.domain}.${def.operation} exists in gateway`, () => {
        const gwSet = def.gateway === 'query' ? queryGwSet : mutateGwSet;
        const key = `${def.domain}.${def.operation}`;
        expect(
          gwSet.has(key),
          `In registry but missing from ${def.gateway} gateway: ${key}`,
        ).toBe(true);
      });
    }
  });

  it('total operation counts match between gateways and registry', () => {
    const gatewayTotal = canonicalQueryOps.length + canonicalMutateOps.length;
    const registryTotal = OPERATIONS.length;

    expect(
      registryTotal,
      `Registry has ${registryTotal} ops, gateways have ${gatewayTotal} canonical ops`,
    ).toBe(gatewayTotal);
  });

  it('no duplicate operations in registry', () => {
    const seen = new Set<string>();
    const duplicates: string[] = [];

    for (const def of OPERATIONS) {
      const key = `${def.gateway}:${def.domain}.${def.operation}`;
      if (seen.has(key)) {
        duplicates.push(key);
      }
      seen.add(key);
    }

    expect(
      duplicates,
      `Duplicate registry entries: ${duplicates.join(', ')}`,
    ).toHaveLength(0);
  });
});
