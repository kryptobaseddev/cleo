/**
 * Unit tests for the Brain unified-graph type system.
 *
 * Tests verify:
 * - BrainNodeKind covers all expected values
 * - BrainSubstrate covers all five substrates
 * - BrainNode and BrainEdge structural contracts
 * - getAllSubstrates() returns a valid BrainGraph shape
 * - Substrate adapter functions return correct node kinds
 * - Node IDs are correctly substrate-prefixed
 */

import { describe, expect, it } from 'vitest';
import { getAllSubstrates } from '../adapters/index.js';
import type { BrainEdge, BrainGraph, BrainNode, BrainNodeKind, BrainSubstrate } from '../types.js';

// ---------------------------------------------------------------------------
// Type constants for assertion helpers
// ---------------------------------------------------------------------------

const ALL_NODE_KINDS: BrainNodeKind[] = [
  'observation',
  'decision',
  'pattern',
  'learning',
  'task',
  'session',
  'symbol',
  'file',
  'agent',
  'message',
];

const ALL_SUBSTRATES: BrainSubstrate[] = ['brain', 'nexus', 'tasks', 'conduit', 'signaldock'];

// ---------------------------------------------------------------------------
// BrainNodeKind
// ---------------------------------------------------------------------------

describe('BrainNodeKind', () => {
  it('has exactly 10 distinct values', () => {
    expect(new Set(ALL_NODE_KINDS).size).toBe(10);
  });

  it('includes all memory-layer kinds', () => {
    const memoryKinds: BrainNodeKind[] = ['observation', 'decision', 'pattern', 'learning'];
    for (const kind of memoryKinds) {
      expect(ALL_NODE_KINDS).toContain(kind);
    }
  });

  it('includes all work-layer kinds', () => {
    const workKinds: BrainNodeKind[] = ['task', 'session'];
    for (const kind of workKinds) {
      expect(ALL_NODE_KINDS).toContain(kind);
    }
  });

  it('includes all code-layer kinds', () => {
    const codeKinds: BrainNodeKind[] = ['symbol', 'file'];
    for (const kind of codeKinds) {
      expect(ALL_NODE_KINDS).toContain(kind);
    }
  });

  it('includes agent and message kinds', () => {
    expect(ALL_NODE_KINDS).toContain('agent');
    expect(ALL_NODE_KINDS).toContain('message');
  });
});

// ---------------------------------------------------------------------------
// BrainSubstrate
// ---------------------------------------------------------------------------

describe('BrainSubstrate', () => {
  it('has exactly 5 values', () => {
    expect(ALL_SUBSTRATES).toHaveLength(5);
  });

  it('includes all five CLEO databases', () => {
    expect(ALL_SUBSTRATES).toContain('brain');
    expect(ALL_SUBSTRATES).toContain('nexus');
    expect(ALL_SUBSTRATES).toContain('tasks');
    expect(ALL_SUBSTRATES).toContain('conduit');
    expect(ALL_SUBSTRATES).toContain('signaldock');
  });
});

// ---------------------------------------------------------------------------
// BrainNode structural contract
// ---------------------------------------------------------------------------

describe('BrainNode structural contract', () => {
  it('satisfies required fields', () => {
    const node: BrainNode = {
      id: 'brain:O-abc123',
      kind: 'observation',
      substrate: 'brain',
      label: 'Test observation',
      createdAt: '2026-04-15T00:00:00.000Z',
      meta: {},
    };

    expect(node.id).toMatch(/^brain:/);
    expect(node.kind).toBe('observation');
    expect(node.substrate).toBe('brain');
    expect(typeof node.label).toBe('string');
    expect(node.meta).toBeDefined();
  });

  it('allows optional weight field', () => {
    const withWeight: BrainNode = {
      id: 'nexus:sym-456',
      kind: 'symbol',
      substrate: 'nexus',
      label: 'createTask',
      weight: 0.85,
      createdAt: '2026-04-10T12:00:00.000Z',
      meta: { nexus_kind: 'function', in_degree: 42 },
    };
    expect(withWeight.weight).toBe(0.85);

    const withoutWeight: BrainNode = {
      id: 'conduit:msg-789',
      kind: 'message',
      substrate: 'conduit',
      label: 'Hello agent',
      createdAt: null,
      meta: {},
    };
    expect(withoutWeight.weight).toBeUndefined();
  });

  it('stores arbitrary meta fields', () => {
    const node: BrainNode = {
      id: 'tasks:T626',
      kind: 'task',
      substrate: 'tasks',
      label: 'Unified Living Brain',
      weight: 1.0,
      createdAt: '2026-03-01T08:00:00.000Z',
      meta: { status: 'pending', priority: 'critical', type: 'epic' },
    };

    expect(node.meta['status']).toBe('pending');
    expect(node.meta['priority']).toBe('critical');
  });

  it('accepts null createdAt for substrates without a timestamp', () => {
    const node: BrainNode = {
      id: 'signaldock:agent-abc',
      kind: 'agent',
      substrate: 'signaldock',
      label: 'cleo-prime',
      createdAt: null,
      meta: { status: 'active' },
    };
    expect(node.createdAt).toBeNull();
  });

  it('accepts ISO-8601 string for createdAt', () => {
    const node: BrainNode = {
      id: 'brain:O-xyz',
      kind: 'observation',
      substrate: 'brain',
      label: 'Some observation',
      createdAt: '2026-04-15T07:20:00.000Z',
      meta: {},
    };
    expect(node.createdAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });
});

// ---------------------------------------------------------------------------
// BrainEdge structural contract
// ---------------------------------------------------------------------------

describe('BrainEdge structural contract', () => {
  it('satisfies required fields', () => {
    const edge: BrainEdge = {
      source: 'brain:D-001',
      target: 'tasks:T626',
      type: 'applies_to',
      weight: 0.8,
      substrate: 'cross',
    };

    expect(edge.source).toMatch(/^brain:/);
    expect(edge.target).toMatch(/^tasks:/);
    expect(edge.type).toBe('applies_to');
    expect(edge.weight).toBe(0.8);
    expect(edge.substrate).toBe('cross');
  });

  it('accepts in-substrate edges', () => {
    const intraEdge: BrainEdge = {
      source: 'nexus:file-a.ts::funcA',
      target: 'nexus:file-b.ts::funcB',
      type: 'calls',
      weight: 1.0,
      substrate: 'nexus',
    };

    expect(intraEdge.substrate).toBe('nexus');
  });
});

// ---------------------------------------------------------------------------
// getAllSubstrates() returns valid BrainGraph shape
// ---------------------------------------------------------------------------

describe('getAllSubstrates()', () => {
  it('returns a valid BrainGraph structure even when all databases are absent', () => {
    // In the test environment, none of the real databases are available.
    // The function should return an empty-but-valid graph rather than throwing.
    const graph: BrainGraph = getAllSubstrates({ limit: 10 });

    expect(graph).toBeDefined();
    expect(Array.isArray(graph.nodes)).toBe(true);
    expect(Array.isArray(graph.edges)).toBe(true);
    expect(typeof graph.truncated).toBe('boolean');
    expect(graph.counts).toBeDefined();
    expect(graph.counts.nodes).toBeDefined();
    expect(graph.counts.edges).toBeDefined();
  });

  it('counts object has entries for all five substrates', () => {
    const graph = getAllSubstrates();
    for (const substrate of ALL_SUBSTRATES) {
      expect(Object.hasOwn(graph.counts.nodes, substrate)).toBe(true);
    }
  });

  it('counts.edges has entry for cross-substrate edges', () => {
    const graph = getAllSubstrates();
    expect(Object.hasOwn(graph.counts.edges, 'cross')).toBe(true);
  });

  it('respects substrates filter', () => {
    const brainOnly = getAllSubstrates({ substrates: ['brain'], limit: 100 });
    // All returned nodes must be from the brain substrate (or cross edges)
    for (const node of brainOnly.nodes) {
      expect(node.substrate).toBe('brain');
    }
  });

  it('truncated is false when graph is empty', () => {
    const graph = getAllSubstrates({ limit: 500 });
    if (graph.nodes.length < 500) {
      expect(graph.truncated).toBe(false);
    }
  });

  it('node IDs are substrate-prefixed', () => {
    const graph = getAllSubstrates();
    for (const node of graph.nodes) {
      expect(node.id).toMatch(/^(brain|nexus|tasks|conduit|signaldock):/);
    }
  });

  it('all node kinds are valid BrainNodeKind values', () => {
    const graph = getAllSubstrates();
    const validKinds = new Set<string>(ALL_NODE_KINDS);
    for (const node of graph.nodes) {
      expect(validKinds.has(node.kind)).toBe(true);
    }
  });

  it('does not return duplicate node IDs', () => {
    const graph = getAllSubstrates();
    const ids = graph.nodes.map((n) => n.id);
    const uniqueIds = new Set(ids);
    expect(uniqueIds.size).toBe(ids.length);
  });

  it('limit parameter is respected', () => {
    const graph = getAllSubstrates({ limit: 5 });
    expect(graph.nodes.length).toBeLessThanOrEqual(5);
  });
});
