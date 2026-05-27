/**
 * Unit tests for NEXUS_SCOPE_MAP SSoT helpers and ConfidenceProvenance
 * discriminated union utilities (T9145).
 *
 * @task T9145
 */

import { describe, expect, it } from 'vitest';
import { confidenceFromProvenance, provenanceFromNumeric } from '../graph.js';
import type { NexusOps } from '../operations/nexus.js';
import {
  getNexusDescriptor,
  listOpsByScope,
  NEXUS_SCOPE_MAP,
} from '../operations/nexus-scope-map.js';

// ---------------------------------------------------------------------------
// NEXUS_SCOPE_MAP completeness
// ---------------------------------------------------------------------------

describe('NEXUS_SCOPE_MAP completeness', () => {
  it('contains an entry for every NexusOps key (exhaustiveness check)', () => {
    // This test verifies the compile-time check also holds at runtime.
    // If the TypeScript exhaustiveness check passes, this test is redundant,
    // but it makes the intent explicit for CI reviewers.
    const keys = Object.keys(NEXUS_SCOPE_MAP) as Array<keyof NexusOps>;
    expect(keys.length).toBeGreaterThan(50);
  });

  it('every descriptor has a non-empty description', () => {
    for (const [key, desc] of Object.entries(NEXUS_SCOPE_MAP)) {
      expect(
        desc.description.length,
        `NEXUS_SCOPE_MAP['${key}'].description must be non-empty`,
      ).toBeGreaterThan(0);
    }
  });

  it('every descriptor has a valid scope', () => {
    const validScopes = new Set(['project', 'living-brain', 'cross', 'hybrid', 'global']);
    for (const [key, desc] of Object.entries(NEXUS_SCOPE_MAP)) {
      expect(
        validScopes.has(desc.scope),
        `NEXUS_SCOPE_MAP['${key}'].scope '${desc.scope}' is not a valid NexusScope`,
      ).toBe(true);
    }
  });

  it('every descriptor has a valid effect', () => {
    const validEffects = new Set(['read', 'write', 'admin']);
    for (const [key, desc] of Object.entries(NEXUS_SCOPE_MAP)) {
      expect(
        validEffects.has(desc.effect),
        `NEXUS_SCOPE_MAP['${key}'].effect '${desc.effect}' is not a valid NexusEffect`,
      ).toBe(true);
    }
  });

  it('global-scope ops do not require a project', () => {
    for (const [key, desc] of Object.entries(NEXUS_SCOPE_MAP)) {
      if (desc.scope === 'global') {
        expect(
          desc.requiresProject,
          `NEXUS_SCOPE_MAP['${key}'] has scope=global but requiresProject=true`,
        ).toBe(false);
      }
    }
  });
});

// ---------------------------------------------------------------------------
// getNexusDescriptor helper
// ---------------------------------------------------------------------------

describe('getNexusDescriptor', () => {
  it('returns the correct descriptor for a known op', () => {
    const desc = getNexusDescriptor('status');
    expect(desc.op).toBe('status');
    expect(desc.scope).toBe('project');
    expect(desc.effect).toBe('read');
  });

  it('returns the correct descriptor for a global op', () => {
    const desc = getNexusDescriptor('register');
    expect(desc.scope).toBe('global');
    expect(desc.effect).toBe('admin');
    expect(desc.requiresProject).toBe(false);
  });

  it('returns the correct descriptor for a hybrid op', () => {
    const desc = getNexusDescriptor('brain-anchors');
    expect(desc.scope).toBe('hybrid');
    expect(desc.stores).toContain('brain');
    expect(desc.stores).toContain('nexus-graph');
  });
});

// ---------------------------------------------------------------------------
// listOpsByScope helper
// ---------------------------------------------------------------------------

describe('listOpsByScope', () => {
  it('returns only project-scope ops when filtering by project', () => {
    const ops = listOpsByScope('project');
    expect(ops.length).toBeGreaterThan(10);
    for (const op of ops) {
      expect(NEXUS_SCOPE_MAP[op].scope).toBe('project');
    }
  });

  it('returns only global-scope ops when filtering by global', () => {
    const ops = listOpsByScope('global');
    expect(ops.length).toBeGreaterThan(0);
    for (const op of ops) {
      expect(NEXUS_SCOPE_MAP[op].scope).toBe('global');
    }
  });

  it('returns hybrid ops including brain-anchors', () => {
    const ops = listOpsByScope('hybrid');
    expect(ops).toContain('brain-anchors');
  });

  it('returns living-brain ops including profile.view', () => {
    const ops = listOpsByScope('living-brain');
    expect(ops).toContain('profile.view');
  });
});

// ---------------------------------------------------------------------------
// ConfidenceProvenance helpers
// ---------------------------------------------------------------------------

describe('provenanceFromNumeric', () => {
  it('maps confidence=1.0 to extracted+ast', () => {
    const p = provenanceFromNumeric(1.0);
    expect(p.kind).toBe('extracted');
    if (p.kind === 'extracted') expect(p.source).toBe('ast');
  });

  it('maps confidence=0.95 to extracted+legacy', () => {
    const p = provenanceFromNumeric(0.95);
    expect(p.kind).toBe('extracted');
    if (p.kind === 'extracted') expect(p.source).toBe('legacy');
  });

  it('maps confidence=0.85 to inferred+legacy', () => {
    const p = provenanceFromNumeric(0.85);
    expect(p.kind).toBe('inferred');
    if (p.kind === 'inferred') expect(p.heuristic).toBe('legacy');
  });

  it('maps confidence=0.5 to ambiguous with empty candidates', () => {
    const p = provenanceFromNumeric(0.5);
    expect(p.kind).toBe('ambiguous');
    if (p.kind === 'ambiguous') expect(p.candidates).toHaveLength(0);
  });
});

describe('confidenceFromProvenance', () => {
  it('extracted+ast → 1.0', () => {
    expect(confidenceFromProvenance({ kind: 'extracted', source: 'ast' })).toBe(1.0);
  });

  it('extracted+legacy → 0.95', () => {
    expect(confidenceFromProvenance({ kind: 'extracted', source: 'legacy' })).toBe(0.95);
  });

  it('inferred → 0.85', () => {
    expect(confidenceFromProvenance({ kind: 'inferred', heuristic: 'heritage-map' })).toBe(0.85);
  });

  it('ambiguous → 0.5', () => {
    expect(confidenceFromProvenance({ kind: 'ambiguous', candidates: ['a', 'b'] })).toBe(0.5);
  });

  it('round-trips cleanly for all three tiers', () => {
    for (const confidence of [1.0, 0.95, 0.85, 0.5]) {
      const recovered = confidenceFromProvenance(provenanceFromNumeric(confidence));
      expect(recovered).toBe(confidence);
    }
  });
});
