/**
 * Unit tests for the /code page data pipeline and filter contract.
 *
 * Exercises the derivation pipeline (server payload → adapter → filter
 * sets) without mounting the Svelte component.  The component itself
 * is smoke-tested as part of the e2e suite.
 *
 * @task T990
 */

import { describe, expect, it } from 'vitest';
import { adaptNexusMacro, mapNexusRelationToEdgeKind } from '$lib/graph/adapters/nexus-adapter.js';
import { ALL_EDGE_KINDS } from '$lib/graph/edge-kinds.js';
import type { EdgeKind } from '$lib/graph/types.js';

describe('/code macro pipeline', () => {
  it('converts API payload into kit nodes + edges', () => {
    const communities = [
      {
        id: 'c1',
        name: 'Memory (45)',
        rawLabel: 'Memory',
        size: 45,
        color: 'var(--info)',
        topKind: 'function',
      },
      {
        id: 'c2',
        name: 'Commands (12)',
        rawLabel: 'Commands',
        size: 12,
        color: 'var(--accent)',
        topKind: 'class',
      },
    ];
    const edges = [
      { source: 'c1', target: 'c2', weight: 50, dominantType: 'calls' },
      { source: 'c2', target: 'c1', weight: 10, dominantType: 'imports' },
    ];

    const adapted = adaptNexusMacro(
      communities.map((c) => ({
        id: c.id,
        label: c.rawLabel,
        memberCount: c.size,
        topKind: c.topKind,
      })),
      edges.map((e) => ({
        source: e.source,
        target: e.target,
        kind: mapNexusRelationToEdgeKind(e.dominantType),
        weight: e.weight,
      })),
    );

    expect(adapted.nodes.length).toBe(2);
    expect(adapted.edges.length).toBe(2);
    expect(adapted.edges[0].kind).toBe('calls');
    expect(adapted.edges[1].kind).toBe('imports');
  });

  it('ALL_EDGE_KINDS includes every filterable kind surfaced on /code', () => {
    const macroKinds: EdgeKind[] = [
      'contains',
      'defines',
      'imports',
      'calls',
      'extends',
      'implements',
      'has_method',
      'has_property',
      'member_of',
      'accesses',
      'references',
      'relates_to',
    ];
    for (const k of macroKinds) {
      expect(ALL_EDGE_KINDS).toContain(k);
    }
  });
});
