/**
 * CI Parity Gate — T5251
 *
 * Fails if the registry drifts from the canonical spec.
 * Update these counts ONLY when operations are intentionally added/removed.
 *
 * This test imports the registry directly (no build or CLI required).
 *
 * @task T5251
 */

import { describe, it, expect } from 'vitest';
import { existsSync } from 'node:fs';
import { join } from 'node:path';

import {
  OPERATIONS,
  resolve,
  getByDomain,
  getActiveDomains,
} from '../../src/dispatch/registry.js';

import { CANONICAL_DOMAINS, type CanonicalDomain } from '../../src/dispatch/types.js';

// ===========================================================================
// Constants — update these ONLY when operations are intentionally changed
// ===========================================================================

const EXPECTED_TOTAL = 200;
const EXPECTED_QUERY = 114;
const EXPECTED_MUTATE = 86;

const EXPECTED_DOMAIN_COUNTS: Record<string, { query: number; mutate: number; total: number }> = {
  tasks:       { query: 14, mutate: 12, total: 26 },
  session:     { query:  8, mutate:  7, total: 15 },
  memory:      { query: 11, mutate:  7, total: 18 },
  check:       { query: 13, mutate:  3, total: 16 },
  pipeline:    { query: 14, mutate: 17, total: 31 },
  orchestrate: { query:  9, mutate:  7, total: 16 },
  tools:       { query: 16, mutate:  6, total: 22 },
  admin:       { query: 15, mutate: 15, total: 30 },
  nexus:       { query: 12, mutate:  8, total: 20 },
  sticky:      { query:  2, mutate:  4, total:  6 },
};

/** Aliases removed in T5245 — must never reappear. */
const REMOVED_ALIASES = [
  'admin.config.get',
  'tools.issue.create.bug',
  'tools.issue.create.feature',
  'tools.issue.create.help',
];

// ===========================================================================
// Tests
// ===========================================================================

describe('CI Parity Gate: Registry Drift Detection', () => {

  it('registry has exactly 10 canonical domains', () => {
    const activeDomains = getActiveDomains();
    expect(activeDomains.sort()).toEqual([...CANONICAL_DOMAINS].sort());
    expect(activeDomains).toHaveLength(10);
  });

  it(`registry has exactly ${EXPECTED_TOTAL} operations total (${EXPECTED_QUERY}q + ${EXPECTED_MUTATE}m)`, () => {
    const queryCount = OPERATIONS.filter(o => o.gateway === 'query').length;
    const mutateCount = OPERATIONS.filter(o => o.gateway === 'mutate').length;

    expect(OPERATIONS.length).toBe(EXPECTED_TOTAL);
    expect(queryCount).toBe(EXPECTED_QUERY);
    expect(mutateCount).toBe(EXPECTED_MUTATE);
  });

  it('each domain has expected operation count', () => {
    for (const [domain, expected] of Object.entries(EXPECTED_DOMAIN_COUNTS)) {
      const ops = getByDomain(domain as CanonicalDomain);
      const queryOps = ops.filter(o => o.gateway === 'query');
      const mutateOps = ops.filter(o => o.gateway === 'mutate');

      expect(ops.length, `${domain}: total mismatch`).toBe(expected.total);
      expect(queryOps.length, `${domain}: query mismatch`).toBe(expected.query);
      expect(mutateOps.length, `${domain}: mutate mismatch`).toBe(expected.mutate);
    }
  });

  it('zero alias operations remain in registry', () => {
    for (const alias of REMOVED_ALIASES) {
      const [domain, ...rest] = alias.split('.');
      const operation = rest.join('.');

      // Try both gateways
      const queryResult = resolve('query', domain as CanonicalDomain, operation);
      const mutateResult = resolve('mutate', domain as CanonicalDomain, operation);

      expect(queryResult, `Removed alias found in query: ${alias}`).toBeUndefined();
      expect(mutateResult, `Removed alias found in mutate: ${alias}`).toBeUndefined();
    }
  });

  it('all 10 canonical domains have handler files', () => {
    const domainsDir = join(import.meta.dirname, '..', '..', 'src', 'dispatch', 'domains');

    for (const domain of CANONICAL_DOMAINS) {
      const handlerPath = join(domainsDir, `${domain}.ts`);
      expect(existsSync(handlerPath), `Missing handler: src/dispatch/domains/${domain}.ts`).toBe(true);
    }
  });

  it('every registered operation is resolvable', () => {
    for (const op of OPERATIONS) {
      const result = resolve(op.gateway, op.domain, op.operation);
      expect(result, `${op.gateway}:${op.domain}.${op.operation} not resolvable`).toBeDefined();
    }
  });

  it('no duplicate operations exist', () => {
    const seen = new Set<string>();
    const duplicates: string[] = [];

    for (const op of OPERATIONS) {
      const key = `${op.gateway}:${op.domain}.${op.operation}`;
      if (seen.has(key)) {
        duplicates.push(key);
      }
      seen.add(key);
    }

    expect(duplicates, 'Duplicate operations found').toEqual([]);
  });
});
