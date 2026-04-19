/**
 * Unit tests for the nexus adapter (T990 wave 1B).
 *
 * @task T990
 */

import { describe, expect, it } from 'vitest';
import { adaptNexusMacro, adaptNexusRows, mapNexusRelationToEdgeKind } from '../nexus-adapter.js';

describe('mapNexusRelationToEdgeKind', () => {
  it('preserves canonical edge kinds', () => {
    expect(mapNexusRelationToEdgeKind('calls')).toBe('calls');
    expect(mapNexusRelationToEdgeKind('extends')).toBe('extends');
    expect(mapNexusRelationToEdgeKind('implements')).toBe('implements');
    expect(mapNexusRelationToEdgeKind('imports')).toBe('imports');
    expect(mapNexusRelationToEdgeKind('contains')).toBe('contains');
    expect(mapNexusRelationToEdgeKind('defines')).toBe('defines');
    expect(mapNexusRelationToEdgeKind('has_method')).toBe('has_method');
    expect(mapNexusRelationToEdgeKind('has_property')).toBe('has_property');
    expect(mapNexusRelationToEdgeKind('member_of')).toBe('member_of');
    expect(mapNexusRelationToEdgeKind('accesses')).toBe('accesses');
    expect(mapNexusRelationToEdgeKind('references')).toBe('references');
    expect(mapNexusRelationToEdgeKind('documents')).toBe('documents');
  });

  it('folds method_overrides into extends', () => {
    expect(mapNexusRelationToEdgeKind('method_overrides')).toBe('extends');
  });

  it('folds method_implements into implements', () => {
    expect(mapNexusRelationToEdgeKind('method_implements')).toBe('implements');
  });

  it('folds unknown strings into relates_to', () => {
    expect(mapNexusRelationToEdgeKind('not_a_real_edge')).toBe('relates_to');
    expect(mapNexusRelationToEdgeKind('')).toBe('relates_to');
  });

  it('maps flow-domain edges to a call-graph kind', () => {
    expect(mapNexusRelationToEdgeKind('step_in_process')).toBe('calls');
    expect(mapNexusRelationToEdgeKind('entry_point_of')).toBe('defines');
    expect(mapNexusRelationToEdgeKind('handles_route')).toBe('calls');
    expect(mapNexusRelationToEdgeKind('handles_tool')).toBe('calls');
  });
});

describe('adaptNexusRows', () => {
  it('emits a node for every input row', () => {
    const { nodes } = adaptNexusRows(
      [
        { id: 'a', label: 'foo', kind: 'function' },
        { id: 'b', label: 'Bar', kind: 'class' },
      ],
      [],
    );
    expect(nodes.map((n) => n.id)).toEqual(['a', 'b']);
    expect(nodes[0].substrate).toBe('nexus');
    expect(nodes[0].label).toBe('foo');
    expect(nodes[1].kind).toBe('class');
  });

  it('drops self-loops and unresolved endpoints', () => {
    const { edges } = adaptNexusRows(
      [
        { id: 'a', label: 'foo', kind: 'function' },
        { id: 'b', label: 'bar', kind: 'function' },
      ],
      [
        { source: 'a', target: 'a', type: 'calls' },
        { source: 'a', target: 'b', type: 'calls' },
        { source: 'c', target: 'b', type: 'calls' },
      ],
    );
    expect(edges.length).toBe(1);
    expect(edges[0].source).toBe('a');
    expect(edges[0].target).toBe('b');
  });

  it('promotes community nodes into clusters and threads members', () => {
    const { clusters, nodes } = adaptNexusRows(
      [
        { id: 'comm_1', label: 'Memory', kind: 'community' },
        { id: 's1', label: 'sym1', kind: 'function', communityId: 'comm_1' },
        { id: 's2', label: 'sym2', kind: 'function', communityId: 'comm_1' },
        { id: 's3', label: 'sym3', kind: 'function' },
      ],
      [],
    );
    expect(clusters.length).toBe(1);
    expect(clusters[0].label).toBe('Memory');
    expect(clusters[0].memberIds).toEqual(expect.arrayContaining(['s1', 's2']));
    expect(clusters[0].memberIds).not.toContain('s3');
    // The community node is itself a member of clusters.memberIds since it's in the same category? It has no category, so no.
    expect(nodes.map((n) => n.id)).toHaveLength(4);
  });

  it('marks directional edges', () => {
    const { edges } = adaptNexusRows(
      [
        { id: 'a', label: 'a', kind: 'function' },
        { id: 'b', label: 'b', kind: 'function' },
      ],
      [
        { source: 'a', target: 'b', type: 'calls' },
        { source: 'a', target: 'b', type: 'relates_to' },
      ],
    );
    expect(edges[0].directional).toBe(true);
    // relates_to is not a real nexus relation; it folds to relates_to and
    // the DIRECTIONAL_KINDS set does not include relates_to.
    expect(edges[1].kind).toBe('relates_to');
    expect(edges[1].directional).toBe(false);
  });

  it('dropMemberOf option skips member_of edges', () => {
    const { edges } = adaptNexusRows(
      [
        { id: 'a', label: 'a', kind: 'function' },
        { id: 'b', label: 'comm_x', kind: 'community' },
      ],
      [{ source: 'a', target: 'b', type: 'member_of' }],
      { dropMemberOf: true },
    );
    expect(edges.length).toBe(0);
  });

  it('normalises caller-count into a log-scaled weight', () => {
    const { nodes } = adaptNexusRows(
      [
        { id: 'a', label: 'a', kind: 'function', callerCount: 0 },
        { id: 'b', label: 'b', kind: 'function', callerCount: 1000 },
        { id: 'c', label: 'c', kind: 'function', callerCount: 10 },
      ],
      [],
    );
    const a = nodes.find((n) => n.id === 'a');
    const b = nodes.find((n) => n.id === 'b');
    const c = nodes.find((n) => n.id === 'c');
    expect(a?.weight).toBeGreaterThan(0);
    expect(b?.weight).toBeCloseTo(1, 1);
    // log10(11) / 3 ≈ 0.347
    expect(c?.weight).toBeLessThan(0.5);
    expect(c?.weight).toBeGreaterThan(0.2);
  });
});

describe('adaptNexusMacro', () => {
  it('builds nodes + clusters from community rows', () => {
    const { nodes, clusters } = adaptNexusMacro(
      [
        { id: 'c1', label: 'Memory', memberCount: 45, topKind: 'function' },
        { id: 'c2', label: 'Commands', memberCount: 12, topKind: 'class' },
      ],
      [],
    );
    expect(nodes.length).toBe(2);
    expect(nodes[0].kind).toBe('community');
    expect(clusters.length).toBe(2);
    expect(clusters[0].id).toBe('c1');
  });

  it('drops self-loops and unresolved macro edges', () => {
    const { edges } = adaptNexusMacro(
      [{ id: 'c1', label: 'a', memberCount: 10, topKind: 'function' }],
      [
        { source: 'c1', target: 'c1', kind: 'calls', weight: 5 },
        { source: 'c1', target: 'c9', kind: 'calls', weight: 5 },
      ],
    );
    expect(edges.length).toBe(0);
  });

  it('preserves the dominant edge kind per aggregate', () => {
    const { edges } = adaptNexusMacro(
      [
        { id: 'c1', label: 'a', memberCount: 10, topKind: 'function' },
        { id: 'c2', label: 'b', memberCount: 10, topKind: 'function' },
      ],
      [
        { source: 'c1', target: 'c2', kind: 'calls', weight: 30 },
        { source: 'c1', target: 'c2', kind: 'extends', weight: 10 },
      ],
    );
    expect(edges.length).toBe(2);
    expect(edges[0].kind).toBe('calls');
    expect(edges[1].kind).toBe('extends');
  });
});
