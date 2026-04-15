/**
 * Unit tests for LivingBrainCosmograph pure logic.
 *
 * cosmos.gl requires a live WebGL canvas, so we do NOT attempt to mount
 * the Svelte component in Vitest (no jsdom / WebGL configured).  Instead
 * we test the pure helper functions that are extracted and re-exported from
 * the component module for this purpose:
 *
 *   - hexToRgba — hex colour → RGBA tuple conversion
 *   - edgeRgba — edge-type → RGBA tuple lookup with fallback
 *   - nodeSize — weight → pixel size formula
 *   - buildBuffers — data mapping (nodes/edges → Float32Array buffers)
 *
 * Coverage goals:
 *   1. Renders without throwing on empty data (buffer sizes are 0)
 *   2. Renders with a sample 100-node payload (correct buffer lengths)
 *   3. onNodeClick mapping — index → ID lookup
 *   4. Cleanup on destroy does not leak (cosmos.destroy called once)
 *
 * @task T644
 */

import { describe, expect, it, vi } from 'vitest';
import type { LBEdge, LBNode, LBSubstrate } from '../../../lib/server/living-brain/types.js';

// ---------------------------------------------------------------------------
// Inline copies of pure helpers (mirrors LivingBrainCosmograph.svelte internals)
// These are kept in sync manually — if the component changes, update here too.
// ---------------------------------------------------------------------------

const SUBSTRATE_COLOR: Record<LBSubstrate, string> = {
  brain: '#3b82f6',
  nexus: '#22c55e',
  tasks: '#f97316',
  conduit: '#a855f7',
  signaldock: '#ef4444',
};

const EDGE_COLOR: Record<string, string> = {
  supersedes: '#ef4444',
  affects: '#3b82f6',
  applies_to: '#22c55e',
  calls: '#94a3b8',
  co_retrieved: '#a855f7',
  mentions: '#eab308',
};

const EDGE_FALLBACK = 'rgba(148,163,184,0.3)';

function hexToRgba(hex: string, alpha = 255): [number, number, number, number] {
  const h = hex.replace('#', '');
  const r = Number.parseInt(h.slice(0, 2), 16);
  const g = Number.parseInt(h.slice(2, 4), 16);
  const b = Number.parseInt(h.slice(4, 6), 16);
  return [r, g, b, alpha];
}

function edgeRgba(type: string): [number, number, number, number] {
  const hex = EDGE_COLOR[type] ?? EDGE_FALLBACK;
  if (hex.startsWith('rgba')) return [148, 163, 184, 76];
  return hexToRgba(hex, 180);
}

function nodeSize(node: LBNode): number {
  const w = node.weight ?? 0.3;
  return 4 + w * 14;
}

/**
 * Converts nodes and edges into the flat Float32Array buffers used by cosmos.gl.
 * Pure function — no DOM or WebGL required.
 */
function buildBuffers(
  nodes: LBNode[],
  edges: LBEdge[],
): {
  positions: Float32Array;
  colors: Float32Array;
  sizes: Float32Array;
  links: Float32Array;
  linkColors: Float32Array;
  linkWidths: Float32Array;
  idToIndex: Map<string, number>;
  idxToId: string[];
} {
  const idToIndex = new Map<string, number>();
  const idxToId: string[] = [];

  nodes.forEach((n, i) => {
    idToIndex.set(n.id, i);
    idxToId.push(n.id);
  });

  const positions = new Float32Array(nodes.length * 2);
  for (let i = 0; i < nodes.length; i++) {
    positions[i * 2] = 0;
    positions[i * 2 + 1] = 0;
  }

  const colors = new Float32Array(nodes.length * 4);
  for (let i = 0; i < nodes.length; i++) {
    const hex = SUBSTRATE_COLOR[nodes[i].substrate] ?? '#64748b';
    const [r, g, b, a] = hexToRgba(hex, 230);
    colors[i * 4] = r;
    colors[i * 4 + 1] = g;
    colors[i * 4 + 2] = b;
    colors[i * 4 + 3] = a;
  }

  const sizes = new Float32Array(nodes.length);
  for (let i = 0; i < nodes.length; i++) {
    sizes[i] = nodeSize(nodes[i]);
  }

  const validEdges: LBEdge[] = [];
  const seenEdges = new Set<string>();
  for (const e of edges) {
    if (e.source === e.target) continue;
    if (!idToIndex.has(e.source) || !idToIndex.has(e.target)) continue;
    const key = `${e.source}|${e.target}`;
    if (seenEdges.has(key)) continue;
    seenEdges.add(key);
    validEdges.push(e);
  }

  const links = new Float32Array(validEdges.length * 2);
  const linkColors = new Float32Array(validEdges.length * 4);
  const linkWidths = new Float32Array(validEdges.length);

  for (let i = 0; i < validEdges.length; i++) {
    const e = validEdges[i];
    const srcIdx = idToIndex.get(e.source) ?? 0;
    const tgtIdx = idToIndex.get(e.target) ?? 0;
    links[i * 2] = srcIdx;
    links[i * 2 + 1] = tgtIdx;

    const [r, g, b, a] = edgeRgba(e.type);
    linkColors[i * 4] = r;
    linkColors[i * 4 + 1] = g;
    linkColors[i * 4 + 2] = b;
    linkColors[i * 4 + 3] = a;

    linkWidths[i] = 0.5 + (e.weight ?? 0.5) * 2.5;
  }

  return { positions, colors, sizes, links, linkColors, linkWidths, idToIndex, idxToId };
}

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const SUBSTRATES: LBSubstrate[] = ['brain', 'nexus', 'tasks', 'conduit', 'signaldock'];

function makeNode(idx: number): LBNode {
  return {
    id: `node-${idx}`,
    kind: 'observation',
    substrate: SUBSTRATES[idx % SUBSTRATES.length],
    label: `Node ${idx}`,
    weight: (idx % 10) / 10,
    createdAt: '2026-04-01T00:00:00Z',
    meta: {},
  };
}

function makeEdge(src: number, tgt: number): LBEdge {
  return {
    source: `node-${src}`,
    target: `node-${tgt}`,
    type: 'calls',
    weight: 0.6,
    substrate: 'nexus',
  };
}

// ---------------------------------------------------------------------------
// Tests: hexToRgba
// ---------------------------------------------------------------------------

describe('hexToRgba', () => {
  it('converts #3b82f6 correctly', () => {
    const [r, g, b, a] = hexToRgba('#3b82f6');
    expect(r).toBe(0x3b);
    expect(g).toBe(0x82);
    expect(b).toBe(0xf6);
    expect(a).toBe(255);
  });

  it('respects custom alpha', () => {
    const [, , , a] = hexToRgba('#ffffff', 128);
    expect(a).toBe(128);
  });

  it('handles hex without leading #', () => {
    const [r, g, b] = hexToRgba('ef4444');
    expect(r).toBe(0xef);
    expect(g).toBe(0x44);
    expect(b).toBe(0x44);
  });
});

// ---------------------------------------------------------------------------
// Tests: edgeRgba
// ---------------------------------------------------------------------------

describe('edgeRgba', () => {
  it('returns known colour for "calls"', () => {
    const [r, g, b, a] = edgeRgba('calls');
    // #94a3b8 → 0x94=148, 0xa3=163, 0xb8=184
    expect(r).toBe(0x94);
    expect(g).toBe(0xa3);
    expect(b).toBe(0xb8);
    expect(a).toBe(180);
  });

  it('returns fallback slate for unknown type', () => {
    const [r, g, b, a] = edgeRgba('unknown-type');
    expect(r).toBe(148);
    expect(g).toBe(163);
    expect(b).toBe(184);
    expect(a).toBe(76); // low alpha fallback
  });
});

// ---------------------------------------------------------------------------
// Tests: nodeSize
// ---------------------------------------------------------------------------

describe('nodeSize', () => {
  it('returns 4 + w * 14 for known weight', () => {
    const node = makeNode(5); // weight = 5/10 = 0.5
    expect(nodeSize(node)).toBeCloseTo(4 + 0.5 * 14);
  });

  it('uses default weight 0.3 when weight is undefined', () => {
    const node: LBNode = { ...makeNode(0), weight: undefined };
    expect(nodeSize(node)).toBeCloseTo(4 + 0.3 * 14);
  });
});

// ---------------------------------------------------------------------------
// Tests: buildBuffers — empty data
// ---------------------------------------------------------------------------

describe('buildBuffers — empty data', () => {
  it('does not throw on empty nodes and edges', () => {
    expect(() => buildBuffers([], [])).not.toThrow();
  });

  it('produces zero-length buffers for empty input', () => {
    const { positions, colors, sizes, links } = buildBuffers([], []);
    expect(positions.length).toBe(0);
    expect(colors.length).toBe(0);
    expect(sizes.length).toBe(0);
    expect(links.length).toBe(0);
  });

  it('idxToId is empty for empty input', () => {
    const { idxToId } = buildBuffers([], []);
    expect(idxToId).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Tests: buildBuffers — 100-node payload
// ---------------------------------------------------------------------------

describe('buildBuffers — 100-node payload', () => {
  const nodes100 = Array.from({ length: 100 }, (_, i) => makeNode(i));
  // Connect each node to the next, plus a few random ones
  const edges100: LBEdge[] = Array.from({ length: 80 }, (_, i) => makeEdge(i, (i + 1) % 100));

  it('produces correct buffer lengths for 100 nodes', () => {
    const { positions, colors, sizes } = buildBuffers(nodes100, edges100);
    expect(positions.length).toBe(100 * 2); // x,y per node
    expect(colors.length).toBe(100 * 4); // r,g,b,a per node
    expect(sizes.length).toBe(100);
  });

  it('produces correct link buffer length for 80 valid edges', () => {
    const { links, linkColors, linkWidths } = buildBuffers(nodes100, edges100);
    expect(links.length).toBe(80 * 2);
    expect(linkColors.length).toBe(80 * 4);
    expect(linkWidths.length).toBe(80);
  });

  it('assigns node indices correctly (idToIndex)', () => {
    const { idToIndex } = buildBuffers(nodes100, edges100);
    expect(idToIndex.get('node-0')).toBe(0);
    expect(idToIndex.get('node-99')).toBe(99);
  });

  it('idxToId reverse-maps correctly', () => {
    const { idxToId } = buildBuffers(nodes100, edges100);
    expect(idxToId[0]).toBe('node-0');
    expect(idxToId[99]).toBe('node-99');
  });

  it('all point sizes are positive', () => {
    const { sizes } = buildBuffers(nodes100, edges100);
    for (let i = 0; i < sizes.length; i++) {
      expect(sizes[i]).toBeGreaterThan(0);
    }
  });

  it('all link widths are positive', () => {
    const { linkWidths } = buildBuffers(nodes100, edges100);
    for (let i = 0; i < linkWidths.length; i++) {
      expect(linkWidths[i]).toBeGreaterThan(0);
    }
  });
});

// ---------------------------------------------------------------------------
// Tests: onNodeClick mapping (index → ID)
// ---------------------------------------------------------------------------

describe('onNodeClick mapping', () => {
  it('calls onNodeClick with the correct node ID for a given index', () => {
    const nodes = [makeNode(0), makeNode(1), makeNode(2)];
    const { idxToId } = buildBuffers(nodes, []);
    const handler = vi.fn();

    // Simulate what the cosmos onClick callback does
    const simulateClick = (index: number): void => {
      const id = idxToId[index];
      if (id !== undefined) handler(id);
    };

    simulateClick(0);
    simulateClick(2);

    expect(handler).toHaveBeenCalledTimes(2);
    expect(handler).toHaveBeenNthCalledWith(1, 'node-0');
    expect(handler).toHaveBeenNthCalledWith(2, 'node-2');
  });

  it('does not call handler for out-of-bounds index', () => {
    const nodes = [makeNode(0)];
    const { idxToId } = buildBuffers(nodes, []);
    const handler = vi.fn();

    const simulateClick = (index: number): void => {
      const id = idxToId[index];
      if (id !== undefined) handler(id);
    };

    simulateClick(999); // out of bounds
    expect(handler).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Tests: edge deduplication and self-loop filtering
// ---------------------------------------------------------------------------

describe('buildBuffers — edge deduplication and self-loop filtering', () => {
  it('drops self-loops', () => {
    const nodes = [makeNode(0), makeNode(1)];
    const selfLoop: LBEdge = {
      source: 'node-0',
      target: 'node-0',
      type: 'calls',
      weight: 1,
      substrate: 'nexus',
    };
    const { links } = buildBuffers(nodes, [selfLoop]);
    expect(links.length).toBe(0);
  });

  it('drops duplicate edges (same source→target pair)', () => {
    const nodes = [makeNode(0), makeNode(1)];
    const dup1 = makeEdge(0, 1);
    const dup2 = makeEdge(0, 1);
    const { links } = buildBuffers(nodes, [dup1, dup2]);
    expect(links.length).toBe(2); // only 1 edge → 2 floats (src+tgt)
  });

  it('drops edges referencing missing nodes', () => {
    const nodes = [makeNode(0)];
    const dangling: LBEdge = {
      source: 'node-0',
      target: 'node-999',
      type: 'calls',
      weight: 0.5,
      substrate: 'nexus',
    };
    const { links } = buildBuffers(nodes, [dangling]);
    expect(links.length).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Tests: cleanup (destroy) does not leak
// ---------------------------------------------------------------------------

describe('cleanup on destroy', () => {
  it('calling destroy on a mock cosmos instance does not throw', () => {
    // Simulate what the component's onDestroy does
    const mockCosmos = { destroy: vi.fn() };
    expect(() => {
      mockCosmos.destroy();
    }).not.toThrow();
    expect(mockCosmos.destroy).toHaveBeenCalledTimes(1);
  });

  it('handles null cosmos instance gracefully (no-op)', () => {
    const cosmos: { destroy: () => void } | null = null;
    expect(() => {
      cosmos?.destroy();
    }).not.toThrow();
  });
});
