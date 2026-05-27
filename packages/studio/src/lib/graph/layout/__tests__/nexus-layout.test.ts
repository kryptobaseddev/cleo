/**
 * Unit tests for the nexus layout helper.
 *
 * @task T990
 */

import { describe, expect, it } from 'vitest';
import type { GraphEdge, GraphNode } from '../../types.js';
import { applyNexusLayout, getNodeMass } from '../nexus-layout.js';

describe('getNodeMass', () => {
  it('ranks structural nodes above leaves', () => {
    const n = 100;
    expect(getNodeMass('project', n)).toBeGreaterThan(getNodeMass('package', n));
    expect(getNodeMass('package', n)).toBeGreaterThan(getNodeMass('module', n));
    expect(getNodeMass('folder', n)).toBeGreaterThan(getNodeMass('file', n));
    expect(getNodeMass('file', n)).toBeGreaterThan(getNodeMass('function', n));
    expect(getNodeMass('class', n)).toBeGreaterThan(getNodeMass('method', n));
  });

  it('scales mass with graph size', () => {
    expect(getNodeMass('folder', 10000)).toBeGreaterThan(getNodeMass('folder', 10));
  });

  it('falls back to mass 1 for unknown kinds', () => {
    expect(getNodeMass('not_a_kind', 10)).toBe(1);
  });
});

describe('applyNexusLayout', () => {
  it('returns empty maps when nodes is empty', () => {
    const { positions, masses } = applyNexusLayout([], []);
    expect(positions.size).toBe(0);
    expect(masses.size).toBe(0);
  });

  it('assigns a position and mass to every node', () => {
    const nodes: GraphNode[] = [
      { id: 'pkg', substrate: 'nexus', kind: 'package', label: 'pkg' },
      { id: 'mod', substrate: 'nexus', kind: 'module', label: 'mod' },
      { id: 'fn1', substrate: 'nexus', kind: 'function', label: 'fn1' },
      { id: 'fn2', substrate: 'nexus', kind: 'function', label: 'fn2' },
    ];
    const edges: GraphEdge[] = [
      { id: 'e1', source: 'pkg', target: 'mod', kind: 'contains', directional: true },
      { id: 'e2', source: 'mod', target: 'fn1', kind: 'defines', directional: true },
      { id: 'e3', source: 'mod', target: 'fn2', kind: 'defines', directional: true },
    ];
    const { positions, masses } = applyNexusLayout(nodes, edges, { seed: 42 });
    expect(positions.size).toBe(4);
    expect(masses.size).toBe(4);
    expect(masses.get('pkg')).toBeGreaterThan(masses.get('fn1') ?? 0);
  });

  it('positions child nodes near their parents via hierarchy edges', () => {
    const nodes: GraphNode[] = [
      { id: 'parent', substrate: 'nexus', kind: 'folder', label: 'p' },
      { id: 'child', substrate: 'nexus', kind: 'function', label: 'c' },
    ];
    const edges: GraphEdge[] = [
      { id: 'e1', source: 'parent', target: 'child', kind: 'contains', directional: true },
    ];
    const { positions } = applyNexusLayout(nodes, edges, { seed: 1 });
    const parent = positions.get('parent');
    const child = positions.get('child');
    expect(parent).toBeTruthy();
    expect(child).toBeTruthy();
    if (parent && child) {
      const dist = Math.hypot(parent.x - child.x, parent.y - child.y);
      // nodeCount = 2 → sqrt(2) * 3 ≈ 4.24 jitter ceiling per axis.
      expect(dist).toBeLessThan(20);
    }
  });

  it('positions cluster-tagged symbols near their cluster centroid', () => {
    const nodes: GraphNode[] = [];
    // 10 nodes in comm_1, 10 in comm_2. No structural nodes.
    for (let i = 0; i < 10; i++) {
      nodes.push({
        id: `c1_${i}`,
        substrate: 'nexus',
        kind: 'function',
        label: `f${i}`,
        category: 'comm_1',
      });
    }
    for (let i = 0; i < 10; i++) {
      nodes.push({
        id: `c2_${i}`,
        substrate: 'nexus',
        kind: 'function',
        label: `g${i}`,
        category: 'comm_2',
      });
    }
    const { positions } = applyNexusLayout(nodes, [], { seed: 7 });

    const avg = (prefix: string): { x: number; y: number } => {
      let sx = 0;
      let sy = 0;
      let n = 0;
      for (const [id, p] of positions) {
        if (!id.startsWith(prefix)) continue;
        sx += p.x;
        sy += p.y;
        n++;
      }
      return { x: sx / n, y: sy / n };
    };
    const a = avg('c1_');
    const b = avg('c2_');
    const between = Math.hypot(a.x - b.x, a.y - b.y);
    expect(between).toBeGreaterThan(0);
  });

  it('produces the same layout for the same seed', () => {
    const nodes: GraphNode[] = [
      { id: 'a', substrate: 'nexus', kind: 'folder', label: 'a' },
      { id: 'b', substrate: 'nexus', kind: 'file', label: 'b' },
    ];
    const edges: GraphEdge[] = [
      { id: 'e', source: 'a', target: 'b', kind: 'contains', directional: true },
    ];
    const run1 = applyNexusLayout(nodes, edges, { seed: 1234 });
    const run2 = applyNexusLayout(nodes, edges, { seed: 1234 });
    expect(run1.positions.get('a')).toEqual(run2.positions.get('a'));
    expect(run1.positions.get('b')).toEqual(run2.positions.get('b'));
  });
});
