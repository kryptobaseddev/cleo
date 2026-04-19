/**
 * Unit tests for the stub-node loader in the living-brain adapters.
 *
 * The stub-node loader runs as a second pass after all substrates are loaded.
 * It collects edge target IDs not yet in the loaded node set and fetches
 * minimal metadata for those targets to prevent edges from being silently dropped.
 *
 * This test verifies that the stub loader correctly:
 * 1. Identifies missing target IDs from edges
 * 2. Partitions them by substrate
 * 3. Creates minimal stub nodes with {id, substrate, kind, label}
 * 4. Marks stubs with meta.isStub: true for UI differentiation
 * 5. Handles edge cases like missing substrates, empty target sets
 */

import { describe, expect, it } from 'vitest';
import type { BrainEdge, BrainNode, BrainSubstrate } from '../types.js';

/**
 * Synthetic implementation of loadStubNodesForEdgeTargets for testing.
 *
 * This mirrors the real function in adapters/index.ts but without DB queries.
 * In the real function, nexus stubs are queried from nexus.db; here we mock that
 * by accepting a set of "nexus nodes that exist in DB".
 */
function loadStubNodesForEdgeTargets(
  loadedNodeIds: Set<string>,
  edges: BrainEdge[],
  nexusDbNodes?: Map<string, { kind: string; name: string }>,
): BrainNode[] {
  // Collect all target IDs referenced by edges but not yet loaded
  const missingTargetIds = new Set<string>();
  for (const edge of edges) {
    if (!loadedNodeIds.has(edge.target)) {
      missingTargetIds.add(edge.target);
    }
  }

  if (missingTargetIds.size === 0) return [];

  // Partition missing target IDs by substrate
  const stubsBySubstrate = new Map<string, string[]>();
  for (const nodeId of missingTargetIds) {
    const sep = nodeId.indexOf(':');
    if (sep === -1) continue;

    const substrateStr = nodeId.slice(0, sep);
    if (!['brain', 'nexus', 'tasks', 'conduit', 'signaldock'].includes(substrateStr)) {
      continue;
    }

    if (!stubsBySubstrate.has(substrateStr)) {
      stubsBySubstrate.set(substrateStr, []);
    }
    stubsBySubstrate.get(substrateStr)!.push(nodeId);
  }

  const stubs: BrainNode[] = [];

  // Load stubs for nexus targets (most common cross-substrate case)
  // In real code this queries nexus.db; here we mock with a Map.
  const nexusStubs = stubsBySubstrate.get('nexus');
  if (nexusStubs && nexusStubs.length > 0 && nexusDbNodes) {
    for (const nodeId of nexusStubs) {
      const rawId = nodeId.replace(/^nexus:/, '');
      const dbNode = nexusDbNodes.get(rawId);
      if (dbNode) {
        const kind = ['file', 'folder', 'module'].includes(dbNode.kind) ? 'file' : 'symbol';
        stubs.push({
          id: nodeId,
          kind,
          substrate: 'nexus',
          label: dbNode.name,
          weight: undefined,
          createdAt: null,
          meta: { nexus_kind: dbNode.kind, isStub: true },
        });
      }
    }
  }

  // For other substrates, create minimal stubs without DB queries
  for (const [substrate, nodeIds] of stubsBySubstrate) {
    if (substrate === 'nexus') continue; // already handled above

    for (const nodeId of nodeIds) {
      const rawId = nodeId.replace(new RegExp(`^${substrate}:`), '');
      stubs.push({
        id: nodeId,
        kind: 'observation', // generic fallback kind
        // Safe: the enclosing loop only runs for keys already validated
        // against the BrainSubstrate literal set above.
        substrate: substrate as BrainSubstrate,
        label: rawId,
        weight: undefined,
        createdAt: null,
        meta: { isStub: true },
      });
    }
  }

  return stubs;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('loadStubNodesForEdgeTargets', () => {
  it('returns empty array when all edge targets are already loaded', () => {
    const loaded = new Set(['nexus:foo', 'nexus:bar']);
    const edges: BrainEdge[] = [
      {
        source: 'brain:O-123',
        target: 'nexus:foo',
        type: 'applies_to',
        weight: 0.5,
        substrate: 'cross',
      },
      {
        source: 'brain:O-123',
        target: 'nexus:bar',
        type: 'applies_to',
        weight: 0.5,
        substrate: 'cross',
      },
    ];

    const stubs = loadStubNodesForEdgeTargets(loaded, edges);
    expect(stubs).toHaveLength(0);
  });

  it('creates stub nodes for missing nexus targets', () => {
    const loaded = new Set(['brain:O-123']);
    const edges: BrainEdge[] = [
      {
        source: 'brain:O-123',
        target: 'nexus:packages/foo.ts::bar',
        type: 'code_reference',
        weight: 0.5,
        substrate: 'cross',
      },
    ];

    const nexusDb = new Map([['packages/foo.ts::bar', { kind: 'function', name: 'bar' }]]);

    const stubs = loadStubNodesForEdgeTargets(loaded, edges, nexusDb);

    expect(stubs).toHaveLength(1);
    expect(stubs[0]).toEqual({
      id: 'nexus:packages/foo.ts::bar',
      kind: 'symbol',
      substrate: 'nexus',
      label: 'bar',
      weight: undefined,
      createdAt: null,
      meta: { nexus_kind: 'function', isStub: true },
    });
  });

  it('creates stub nodes for missing tasks targets without DB query', () => {
    const loaded = new Set(['brain:O-123']);
    const edges: BrainEdge[] = [
      {
        source: 'brain:O-123',
        target: 'tasks:T456',
        type: 'applies_to',
        weight: 0.5,
        substrate: 'cross',
      },
    ];

    const stubs = loadStubNodesForEdgeTargets(loaded, edges);

    expect(stubs).toHaveLength(1);
    expect(stubs[0]).toEqual({
      id: 'tasks:T456',
      kind: 'observation',
      substrate: 'tasks',
      label: 'T456',
      weight: undefined,
      createdAt: null,
      meta: { isStub: true },
    });
  });

  it('deduplicates multiple edges targeting the same missing node', () => {
    const loaded = new Set(['brain:O-123', 'brain:O-456']);
    const edges: BrainEdge[] = [
      {
        source: 'brain:O-123',
        target: 'tasks:T789',
        type: 'applies_to',
        weight: 0.5,
        substrate: 'cross',
      },
      {
        source: 'brain:O-456',
        target: 'tasks:T789',
        type: 'applies_to',
        weight: 0.6,
        substrate: 'cross',
      },
    ];

    const stubs = loadStubNodesForEdgeTargets(loaded, edges);

    // Only one stub for T789, even though two edges target it
    expect(stubs).toHaveLength(1);
    expect(stubs[0].id).toBe('tasks:T789');
  });

  it('handles mixed substrate targets in a single edge set', () => {
    const loaded = new Set<string>();
    const edges: BrainEdge[] = [
      {
        source: 'brain:O-111',
        target: 'tasks:T222',
        type: 'applies_to',
        weight: 0.5,
        substrate: 'cross',
      },
      {
        source: 'brain:O-111',
        target: 'nexus:file.ts::Symbol',
        type: 'code_reference',
        weight: 0.5,
        substrate: 'cross',
      },
      {
        source: 'brain:O-111',
        target: 'conduit:msg-333',
        type: 'mentions',
        weight: 0.5,
        substrate: 'cross',
      },
    ];

    const nexusDb = new Map([['file.ts::Symbol', { kind: 'class', name: 'Symbol' }]]);

    const stubs = loadStubNodesForEdgeTargets(loaded, edges, nexusDb);

    expect(stubs).toHaveLength(3);

    const nexusStub = stubs.find((s) => s.id === 'nexus:file.ts::Symbol');
    expect(nexusStub).toBeDefined();
    expect(nexusStub!.meta.isStub).toBe(true);
    expect(nexusStub!.kind).toBe('symbol');

    const tasksStub = stubs.find((s) => s.id === 'tasks:T222');
    expect(tasksStub).toBeDefined();
    expect(tasksStub!.meta.isStub).toBe(true);

    const conduitStub = stubs.find((s) => s.id === 'conduit:msg-333');
    expect(conduitStub).toBeDefined();
    expect(conduitStub!.meta.isStub).toBe(true);
  });

  it('recognizes file nodes in nexus and sets kind correctly', () => {
    const loaded = new Set<string>();
    const edges: BrainEdge[] = [
      {
        source: 'brain:O-111',
        target: 'nexus:packages/foo/bar.ts',
        type: 'modified_by',
        weight: 0.5,
        substrate: 'cross',
      },
    ];

    const nexusDb = new Map([['packages/foo/bar.ts', { kind: 'file', name: 'bar.ts' }]]);

    const stubs = loadStubNodesForEdgeTargets(loaded, edges, nexusDb);

    expect(stubs).toHaveLength(1);
    expect(stubs[0].kind).toBe('file'); // file, folder, or module
    expect(stubs[0].meta.isStub).toBe(true);
  });

  it('skips nodes with malformed IDs (no substrate prefix)', () => {
    const loaded = new Set<string>();
    const edges: BrainEdge[] = [
      {
        source: 'brain:O-111',
        target: 'malformed-id-no-colon',
        type: 'applies_to',
        weight: 0.5,
        substrate: 'cross',
      },
    ];

    const stubs = loadStubNodesForEdgeTargets(loaded, edges);

    expect(stubs).toHaveLength(0);
  });

  it('skips targets with unknown substrate prefix', () => {
    const loaded = new Set<string>();
    const edges: BrainEdge[] = [
      {
        source: 'brain:O-111',
        target: 'unknown:something',
        type: 'applies_to',
        weight: 0.5,
        substrate: 'cross',
      },
    ];

    const stubs = loadStubNodesForEdgeTargets(loaded, edges);

    expect(stubs).toHaveLength(0);
  });

  it('continues gracefully when nexus DB lookup fails for a node', () => {
    const loaded = new Set<string>();
    const edges: BrainEdge[] = [
      {
        source: 'brain:O-111',
        target: 'nexus:nonexistent.ts::Missing',
        type: 'code_reference',
        weight: 0.5,
        substrate: 'cross',
      },
    ];

    const nexusDb = new Map([
      // Does not include 'nonexistent.ts::Missing'
    ]);

    const stubs = loadStubNodesForEdgeTargets(loaded, edges, nexusDb);

    // Stub loader silently skips DB-missed nodes
    expect(stubs).toHaveLength(0);
  });

  it('marks all stubs with isStub: true for UI differentiation', () => {
    const loaded = new Set<string>();
    const edges: BrainEdge[] = [
      {
        source: 'brain:O-111',
        target: 'tasks:T222',
        type: 'applies_to',
        weight: 0.5,
        substrate: 'cross',
      },
      {
        source: 'brain:O-111',
        target: 'nexus:file.ts::Symbol',
        type: 'code_reference',
        weight: 0.5,
        substrate: 'cross',
      },
    ];

    const nexusDb = new Map([['file.ts::Symbol', { kind: 'class', name: 'Symbol' }]]);

    const stubs = loadStubNodesForEdgeTargets(loaded, edges, nexusDb);

    for (const stub of stubs) {
      expect(stub.meta.isStub).toBe(true);
    }
  });

  it('handles signaldock substrate targets', () => {
    const loaded = new Set<string>();
    const edges: BrainEdge[] = [
      {
        source: 'brain:O-111',
        target: 'signaldock:agent-abc',
        type: 'authored_by',
        weight: 0.5,
        substrate: 'cross',
      },
    ];

    const stubs = loadStubNodesForEdgeTargets(loaded, edges);

    expect(stubs).toHaveLength(1);
    expect(stubs[0].id).toBe('signaldock:agent-abc');
    expect(stubs[0].substrate).toBe('signaldock');
    expect(stubs[0].meta.isStub).toBe(true);
  });

  it('handles brain substrate targets (edge case)', () => {
    const loaded = new Set<string>();
    const edges: BrainEdge[] = [
      {
        source: 'nexus:packages/foo.ts::bar',
        target: 'brain:O-999',
        type: 'cross_reference',
        weight: 0.5,
        substrate: 'cross',
      },
    ];

    const stubs = loadStubNodesForEdgeTargets(loaded, edges);

    expect(stubs).toHaveLength(1);
    expect(stubs[0].id).toBe('brain:O-999');
    expect(stubs[0].substrate).toBe('brain');
    expect(stubs[0].meta.isStub).toBe(true);
  });
});
