/**
 * Guard test: every edge_type value emitted by shipped source code MUST appear
 * in BRAIN_EDGE_TYPES.
 *
 * This test prevents a class of silent runtime bugs where an INSERT with an
 * unregistered edge type succeeds only because the raw SQL bypasses Drizzle's
 * typed enum check, leaving stale / unrecognised rows in brain_page_edges.
 *
 * When adding a new edge type:
 *   1. Add it to BRAIN_EDGE_TYPES in packages/core/src/store/brain-schema.ts
 *   2. Optionally add a named constant to packages/core/src/memory/edge-types.ts
 *   3. Add the new literal to the EMITTED_EDGE_TYPES array below
 *
 * @task T645
 * @epic T626
 */

import { describe, expect, it } from 'vitest';
import { BRAIN_EDGE_TYPES } from '../../store/brain-schema.js';
import { EDGE_TYPES } from '../edge-types.js';

// ---------------------------------------------------------------------------
// The complete set of edge_type values that shipped code may write to
// brain_page_edges.  Derived by grepping for:
//   - edgeType: '<literal>'         (Drizzle insert paths)
//   - edge_type = '<literal>'       (raw SQL INSERT paths, excluding WHERE)
//   - VALUES (?, ?, '<literal>', …) (raw SQL INSERT paths)
//   - EDGE_TYPES.<CONSTANT>         (constant-keyed paths)
//
// Reference files:
//   packages/core/src/memory/brain-backfill.ts
//   packages/core/src/memory/brain-consolidator.ts
//   packages/core/src/memory/brain-lifecycle.ts
//   packages/core/src/memory/brain-stdp.ts
//   packages/core/src/memory/graph-memory-bridge.ts
//   packages/core/src/memory/temporal-supersession.ts
// ---------------------------------------------------------------------------
const EMITTED_EDGE_TYPES: readonly string[] = [
  'applies_to', // brain-backfill.ts: task→decision/pattern context links
  'code_reference', // graph-memory-bridge.ts: memory node → nexus symbol/file (T645)
  'contradicts', // brain-consolidator.ts: contradiction detection edges
  'co_retrieved', // brain-lifecycle.ts + brain-stdp.ts: Hebbian co-retrieval
  'derived_from', // brain-backfill.ts: learning←observation provenance
  'produced_by', // brain-backfill.ts: observation←session provenance
  'supersedes', // temporal-supersession.ts: decision supersession edges
] as const;

describe('BRAIN_EDGE_TYPES enum coverage', () => {
  it('BRAIN_EDGE_TYPES must be a non-empty tuple', () => {
    expect(BRAIN_EDGE_TYPES.length).toBeGreaterThan(0);
  });

  it.each(
    EMITTED_EDGE_TYPES,
  )("edge type '%s' emitted by shipped code is present in BRAIN_EDGE_TYPES", (emittedType) => {
    expect(BRAIN_EDGE_TYPES).toContain(emittedType);
  });

  it('EDGE_TYPES constant values are a subset of BRAIN_EDGE_TYPES', () => {
    for (const [key, value] of Object.entries(EDGE_TYPES)) {
      expect(
        BRAIN_EDGE_TYPES,
        `EDGE_TYPES.${key} = '${value}' is missing from BRAIN_EDGE_TYPES`,
      ).toContain(value);
    }
  });

  it('co_retrieved is in BRAIN_EDGE_TYPES (T626 Hebbian strengthener)', () => {
    expect(BRAIN_EDGE_TYPES).toContain('co_retrieved');
  });

  it('code_reference is in BRAIN_EDGE_TYPES (T645 enum drift fix)', () => {
    expect(BRAIN_EDGE_TYPES).toContain('code_reference');
  });

  it('EDGE_TYPES.CO_RETRIEVED equals the string co_retrieved', () => {
    expect(EDGE_TYPES.CO_RETRIEVED).toBe('co_retrieved');
  });

  it('EDGE_TYPES.CODE_REFERENCE equals the string code_reference', () => {
    expect(EDGE_TYPES.CODE_REFERENCE).toBe('code_reference');
  });

  it('no duplicate values in BRAIN_EDGE_TYPES', () => {
    const seen = new Set<string>();
    for (const edgeType of BRAIN_EDGE_TYPES) {
      expect(seen.has(edgeType), `duplicate edge type '${edgeType}' in BRAIN_EDGE_TYPES`).toBe(
        false,
      );
      seen.add(edgeType);
    }
  });
});
