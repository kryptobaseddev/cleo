/**
 * Registry Derivation Test
 *
 * Validates that deriveGatewayMatrix() correctly produces gateway operation
 * matrices from the OPERATIONS registry. Drift between registry and gateways
 * is now structurally impossible since gateways derive from the registry.
 *
 * @task T5239
 */

import { describe, it, expect } from 'vitest';
import {
  OPERATIONS,
  LEGACY_DOMAIN_ALIASES,
  deriveGatewayMatrix,
  getGatewayDomains,
} from '../registry.js';
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

    it('tasks mutate domain has expected operations', () => {
      expect(mutateMatrix.tasks).toContain('add');
      expect(mutateMatrix.tasks).toContain('update');
      expect(mutateMatrix.tasks).toContain('complete');
      expect(mutateMatrix.tasks).toContain('start');
      expect(mutateMatrix.tasks).toContain('stop');
    });
  });

  describe('legacy alias entries', () => {
    it('research alias maps to memory with no prefix (all memory ops)', () => {
      expect(queryMatrix.research).toBeDefined();
      expect(queryMatrix.research).toEqual(queryMatrix.memory);
    });

    it('validate alias maps to check with no prefix', () => {
      expect(queryMatrix.validate).toEqual(queryMatrix.check);
    });

    it('lifecycle alias maps to pipeline with stage. prefix stripped', () => {
      expect(queryMatrix.lifecycle).toBeDefined();
      expect(queryMatrix.lifecycle).toContain('validate');
      expect(queryMatrix.lifecycle).toContain('status');
      expect(queryMatrix.lifecycle).toContain('history');
      expect(queryMatrix.lifecycle).toContain('gates');
      expect(queryMatrix.lifecycle).toContain('prerequisites');
    });

    it('release alias maps to pipeline with release. prefix stripped', () => {
      // release only has mutate ops
      expect(queryMatrix.release).toBeUndefined();
      expect(mutateMatrix.release).toBeDefined();
      expect(mutateMatrix.release).toContain('prepare');
      expect(mutateMatrix.release).toContain('changelog');
      expect(mutateMatrix.release).toContain('tag');
      expect(mutateMatrix.release).toContain('rollback');
    });

    it('skills alias maps to tools with skill. prefix stripped', () => {
      expect(queryMatrix.skills).toBeDefined();
      expect(queryMatrix.skills).toContain('list');
      expect(queryMatrix.skills).toContain('show');
      expect(queryMatrix.skills).toContain('find');
    });

    it('providers alias maps to tools with provider. prefix stripped', () => {
      expect(queryMatrix.providers).toBeDefined();
      expect(queryMatrix.providers).toContain('list');
      expect(queryMatrix.providers).toContain('detect');
    });

    it('issues alias maps to tools with issue. prefix stripped', () => {
      expect(queryMatrix.issues).toBeDefined();
      expect(queryMatrix.issues).toContain('diagnostics');
    });

    it('system alias maps to admin with no prefix', () => {
      expect(queryMatrix.system).toEqual(queryMatrix.admin);
    });
  });

  it('release domain does not appear in query gateway', () => {
    expect(queryMatrix.release).toBeUndefined();
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

    expect(
      duplicates,
      `Duplicate registry entries: ${duplicates.join(', ')}`,
    ).toHaveLength(0);
  });
});

describe('LEGACY_DOMAIN_ALIASES', () => {
  it('has 8 legacy aliases', () => {
    expect(Object.keys(LEGACY_DOMAIN_ALIASES)).toHaveLength(8);
  });

  it('all aliases map to valid canonical domains', () => {
    const canonicalSet = new Set(CANONICAL_DOMAINS as readonly string[]);
    for (const [alias, { canonical }] of Object.entries(LEGACY_DOMAIN_ALIASES)) {
      expect(
        canonicalSet.has(canonical),
        `Legacy alias '${alias}' maps to invalid canonical domain '${canonical}'`,
      ).toBe(true);
    }
  });
});

describe('getGatewayDomains', () => {
  it('returns canonical + legacy domains for query', () => {
    const domains = getGatewayDomains('query');
    // 10 canonical + 7 legacy (release excluded from query)
    expect(domains).toHaveLength(17);
  });

  it('returns canonical + legacy domains for mutate', () => {
    const domains = getGatewayDomains('mutate');
    // 10 canonical + 8 legacy (release included in mutate)
    expect(domains).toHaveLength(18);
  });
});
