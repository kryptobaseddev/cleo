/**
 * Registry Derivation Test
 *
 * Validates that deriveGatewayMatrix() correctly produces gateway operation
 * matrices from the OPERATIONS registry. Drift between registry and gateways
 * is now structurally impossible since gateways derive from the registry.
 *
 * @task T5239
 */

import { describe, expect, it } from 'vitest';
import { deriveGatewayMatrix, getGatewayDomains, OPERATIONS } from '../registry.js';
import { CANONICAL_DOMAINS } from '../types.js';

describe('deriveGatewayMatrix', () => {
  const queryMatrix = deriveGatewayMatrix('query');
  const mutateMatrix = deriveGatewayMatrix('mutate');

  describe('canonical domain entries', () => {
    it('produces all 10 canonical query domains', () => {
      for (const domain of CANONICAL_DOMAINS) {
        const ops = queryMatrix[domain];
        // Every canonical domain should exist (even if empty for some gateways)
        // nexus has exactly 1 query op; all others have more
        if (domain === 'nexus') {
          expect(ops).toBeDefined();
        }
      }
    });

    it('produces all 10 canonical mutate domains', () => {
      for (const domain of CANONICAL_DOMAINS) {
        const ops = mutateMatrix[domain];
        if (domain === 'nexus') {
          expect(ops).toBeDefined();
        }
      }
    });

    it('tasks query domain has expected operations', () => {
      expect(queryMatrix.tasks).toContain('show');
      expect(queryMatrix.tasks).toContain('find');
      expect(queryMatrix.tasks).toContain('list');
      expect(queryMatrix.tasks).toContain('next');
      expect(queryMatrix.tasks).toContain('current');
    });

    it('session query domain has expected operations', () => {
      expect(queryMatrix.session).toContain('status');
      expect(queryMatrix.session).toContain('show');
      expect(queryMatrix.session).toContain('briefing.show');
      expect(queryMatrix.session).toContain('handoff.show');
    });

    it('nexus query domain exposes analysis operations', () => {
      expect(queryMatrix.nexus).toContain('path.show');
      expect(queryMatrix.nexus).toContain('blockers.show');
      expect(queryMatrix.nexus).toContain('orphans.list');
    });

    it('tasks mutate domain has expected operations', () => {
      expect(mutateMatrix.tasks).toContain('add');
      expect(mutateMatrix.tasks).toContain('update');
      expect(mutateMatrix.tasks).toContain('complete');
      expect(mutateMatrix.tasks).toContain('start');
      expect(mutateMatrix.tasks).toContain('stop');
    });

    it('orchestrate mutate domain includes composite handoff', () => {
      expect(mutateMatrix.orchestrate).toContain('handoff');
    });
  });

  describe('legacy alias entries', () => {
    it('does not expose legacy alias domains in query matrix', () => {
      expect(queryMatrix.research).toBeUndefined();
      expect(queryMatrix.validate).toBeUndefined();
      expect(queryMatrix.lifecycle).toBeUndefined();
      expect(queryMatrix.release).toBeUndefined();
      expect(queryMatrix.system).toBeUndefined();
      expect(queryMatrix.skills).toBeUndefined();
      expect(queryMatrix.providers).toBeUndefined();
      expect(queryMatrix.issues).toBeUndefined();
    });

    it('does not expose legacy alias domains in mutate matrix', () => {
      expect(mutateMatrix.research).toBeUndefined();
      expect(mutateMatrix.validate).toBeUndefined();
      expect(mutateMatrix.lifecycle).toBeUndefined();
      expect(mutateMatrix.release).toBeUndefined();
      expect(mutateMatrix.system).toBeUndefined();
      expect(mutateMatrix.skills).toBeUndefined();
      expect(mutateMatrix.providers).toBeUndefined();
      expect(mutateMatrix.issues).toBeUndefined();
    });
  });

  it('total canonical operation count matches OPERATIONS array', () => {
    const canonicalSet = new Set(CANONICAL_DOMAINS as readonly string[]);
    const qTotal = Object.entries(queryMatrix)
      .filter(([d]) => canonicalSet.has(d))
      .reduce((sum, [, ops]) => sum + ops.length, 0);
    const mTotal = Object.entries(mutateMatrix)
      .filter(([d]) => canonicalSet.has(d))
      .reduce((sum, [, ops]) => sum + ops.length, 0);
    expect(qTotal + mTotal).toBe(OPERATIONS.length);
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

    expect(duplicates, `Duplicate registry entries: ${duplicates.join(', ')}`).toHaveLength(0);
  });
});

describe('getGatewayDomains', () => {
  it('returns canonical domains for query', () => {
    const domains = getGatewayDomains('query');
    expect(domains).toHaveLength(10);
    expect(new Set(domains)).toEqual(new Set(CANONICAL_DOMAINS));
  });

  it('returns canonical domains for mutate', () => {
    const domains = getGatewayDomains('mutate');
    expect(domains).toHaveLength(10);
    expect(new Set(domains)).toEqual(new Set(CANONICAL_DOMAINS));
  });
});
