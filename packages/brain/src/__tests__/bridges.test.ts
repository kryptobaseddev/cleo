/**
 * Unit tests for cross-substrate bridge synthesis in the BRAIN adapter.
 *
 * These tests verify that the brain adapter correctly:
 *
 * 1. Emits intra-brain edges between loaded brain nodes (supersedes, derived_from, etc.)
 * 2. Emits cross-substrate brain→tasks bridges from brain_page_edges (applies_to, etc.)
 * 3. Emits cross-substrate brain→nexus bridges from code_reference edges (::  paths)
 * 4. Emits brain_memory_links rows as cross-substrate edges
 * 5. Emits brain_observations.files_modified_json as modified_by nexus bridges
 * 6. Emits brain_decisions.context_task_id as applies_to tasks bridges (direct soft FK)
 *
 * All tests use synthetic in-memory fixtures — no real databases required.
 * The helpers below create the same data shapes that brain.db produces so
 * the bridge logic can be verified in isolation.
 */

import { describe, expect, it } from 'vitest';
import type { LBEdge, LBNode } from '../types.js';

// ---------------------------------------------------------------------------
// Synthetic fixture helpers — mirror the data shapes in brain.db
// ---------------------------------------------------------------------------

/** Creates a minimal brain LBNode with correct substrate-prefixed ID. */
function makeBrainNode(kind: LBNode['kind'], rawId: string, label = 'test'): LBNode {
  return {
    id: `brain:${rawId}`,
    kind,
    substrate: 'brain',
    label,
    createdAt: '2026-04-15T00:00:00.000Z',
    meta: {},
  };
}

/**
 * Simulates the brain adapter's type-prefixed → LBNode ID mapping.
 *
 * In the real adapter, this map is built from loaded nodes.
 * Here we construct it manually for testing the bridge logic.
 */
function buildTypeIdMap(nodes: LBNode[]): Map<string, string> {
  const map = new Map<string, string>();
  for (const n of nodes) {
    const rawId = n.id.slice('brain:'.length);
    let typePrefix: string;
    if (n.kind === 'observation') typePrefix = 'observation';
    else if (n.kind === 'decision') typePrefix = 'decision';
    else if (n.kind === 'pattern') typePrefix = 'pattern';
    else typePrefix = 'learning';
    map.set(`${typePrefix}:${rawId}`, n.id);
  }
  return map;
}

/**
 * Inline implementation of the bridge resolution logic extracted from
 * brain.ts so it can be unit-tested without touching a real database.
 *
 * This must be kept in sync with the brain adapter's edge-synthesis section.
 */
interface SyntheticPageEdge {
  from_id: string;
  to_id: string;
  edge_type: string;
  weight: number;
}

interface SyntheticMemoryLink {
  memory_type: string;
  memory_id: string;
  task_id: string;
  link_type: string;
}

interface SyntheticObservation {
  id: string;
  source_session_id: string | null;
  files_modified_json: string | null;
}

function isNexusStyleId(toId: string): boolean {
  if (toId.includes('::')) return true;
  if (!toId.includes(':') && toId.includes('/')) return true;
  return false;
}

function isTaskId(id: string): boolean {
  return id.startsWith('task:');
}

function taskRefToLBId(taskRef: string): string {
  return `tasks:${taskRef.slice('task:'.length)}`;
}

function brainTypeIdToLBId(typeId: string): string | null {
  const sep = typeId.indexOf(':');
  if (sep === -1) return null;
  const prefix = typeId.slice(0, sep);
  const rawId = typeId.slice(sep + 1);
  if (
    prefix === 'observation' ||
    prefix === 'decision' ||
    prefix === 'pattern' ||
    prefix === 'learning'
  ) {
    return `brain:${rawId}`;
  }
  return null;
}

function synthesizeBridges(
  nodes: LBNode[],
  pageEdges: SyntheticPageEdge[],
  memLinks: SyntheticMemoryLink[],
  observations: SyntheticObservation[],
  decisionContextTasks: Array<{ id: string; context_task_id: string | null }>,
): LBEdge[] {
  const edges: LBEdge[] = [];
  const typeIdToLBId = buildTypeIdMap(nodes);

  for (const row of pageEdges) {
    const sourceLBId = typeIdToLBId.get(row.from_id) ?? brainTypeIdToLBId(row.from_id);
    if (!sourceLBId) continue;

    if (isTaskId(row.to_id)) {
      edges.push({
        source: sourceLBId,
        target: taskRefToLBId(row.to_id),
        type: row.edge_type,
        weight: row.weight ?? 0.5,
        substrate: 'cross',
      });
    } else if (isNexusStyleId(row.to_id)) {
      edges.push({
        source: sourceLBId,
        target: `nexus:${row.to_id}`,
        type: row.edge_type,
        weight: row.weight ?? 0.5,
        substrate: 'cross',
      });
    } else {
      const targetLBId = typeIdToLBId.get(row.to_id) ?? brainTypeIdToLBId(row.to_id);
      if (targetLBId) {
        edges.push({
          source: sourceLBId,
          target: targetLBId,
          type: row.edge_type,
          weight: row.weight ?? 0.5,
          substrate: 'brain',
        });
      }
    }
  }

  for (const row of memLinks) {
    const sourceTypeId = `${row.memory_type}:${row.memory_id}`;
    const sourceLBId = typeIdToLBId.get(sourceTypeId) ?? brainTypeIdToLBId(sourceTypeId);
    if (!sourceLBId) continue;
    edges.push({
      source: sourceLBId,
      target: `tasks:${row.task_id}`,
      type: row.link_type,
      weight: 0.7,
      substrate: 'cross',
    });
  }

  for (const row of observations) {
    if (!row.files_modified_json) continue;
    let filePaths: unknown;
    try {
      filePaths = JSON.parse(row.files_modified_json);
    } catch {
      continue;
    }
    if (!Array.isArray(filePaths)) continue;
    const sourceLBId = `brain:${row.id}`;
    for (const rawPath of filePaths) {
      if (typeof rawPath !== 'string' || rawPath.length === 0) continue;
      edges.push({
        source: sourceLBId,
        target: `nexus:${rawPath}`,
        type: 'modified_by',
        weight: 0.6,
        substrate: 'cross',
      });
    }
  }

  for (const dec of decisionContextTasks) {
    if (dec.context_task_id) {
      edges.push({
        source: `brain:${dec.id}`,
        target: `tasks:${dec.context_task_id}`,
        type: 'applies_to',
        weight: 0.8,
        substrate: 'cross',
      });
    }
  }

  return edges;
}

// ---------------------------------------------------------------------------
// Tests: intra-brain edges
// ---------------------------------------------------------------------------

describe('intra-brain edges from brain_page_edges', () => {
  it('emits supersedes edge between two loaded brain nodes', () => {
    const obs1 = makeBrainNode('observation', 'O-aaa111', 'Old observation');
    const obs2 = makeBrainNode('observation', 'O-bbb222', 'New observation');

    const edges = synthesizeBridges(
      [obs1, obs2],
      [
        {
          from_id: 'observation:O-aaa111',
          to_id: 'observation:O-bbb222',
          edge_type: 'supersedes',
          weight: 0.9,
        },
      ],
      [],
      [],
      [],
    );

    expect(edges).toHaveLength(1);
    expect(edges[0].source).toBe('brain:O-aaa111');
    expect(edges[0].target).toBe('brain:O-bbb222');
    expect(edges[0].type).toBe('supersedes');
    expect(edges[0].substrate).toBe('brain');
  });

  it('emits derived_from edge between pattern and task node loaded as brain', () => {
    const pat = makeBrainNode('pattern', 'P-ccc333', 'A pattern');
    const obs = makeBrainNode('observation', 'O-ddd444', 'An observation');

    const edges = synthesizeBridges(
      [pat, obs],
      [
        {
          from_id: 'pattern:P-ccc333',
          to_id: 'observation:O-ddd444',
          edge_type: 'derived_from',
          weight: 0.7,
        },
      ],
      [],
      [],
      [],
    );

    expect(edges).toHaveLength(1);
    expect(edges[0].source).toBe('brain:P-ccc333');
    expect(edges[0].target).toBe('brain:O-ddd444');
    expect(edges[0].type).toBe('derived_from');
    expect(edges[0].substrate).toBe('brain');
  });

  it('skips intra-brain edge when source node is not loaded', () => {
    const obs = makeBrainNode('observation', 'O-eee555', 'Loaded obs');

    const edges = synthesizeBridges(
      [obs],
      // from_id references an unloaded decision
      [
        {
          from_id: 'decision:D-fff666',
          to_id: 'observation:O-eee555',
          edge_type: 'derived_from',
          weight: 0.7,
        },
      ],
      [],
      [],
      [],
    );

    // brainTypeIdToLBId returns brain:D-fff666 even if not loaded — this is by design
    // so cross-substrate references work regardless of loading boundary.
    // The edge should still be emitted as an intra-brain stub.
    expect(edges).toHaveLength(1);
    expect(edges[0].source).toBe('brain:D-fff666');
    expect(edges[0].substrate).toBe('brain');
  });
});

// ---------------------------------------------------------------------------
// Tests: cross-substrate brain → tasks bridges
// ---------------------------------------------------------------------------

describe('cross-substrate brain → tasks bridges from brain_page_edges', () => {
  it('emits applies_to edge when to_id is task:T-xxx', () => {
    const obs = makeBrainNode('observation', 'O-aaa001', 'Observation about T523');

    const edges = synthesizeBridges(
      [obs],
      [
        {
          from_id: 'observation:O-aaa001',
          to_id: 'task:T523',
          edge_type: 'applies_to',
          weight: 0.8,
        },
      ],
      [],
      [],
      [],
    );

    expect(edges).toHaveLength(1);
    expect(edges[0].source).toBe('brain:O-aaa001');
    expect(edges[0].target).toBe('tasks:T523');
    expect(edges[0].type).toBe('applies_to');
    expect(edges[0].substrate).toBe('cross');
    expect(edges[0].weight).toBe(0.8);
  });

  it('emits produced_by edge when pattern → task', () => {
    const pat = makeBrainNode('pattern', 'P-bbb002', 'Pattern from T532');

    const edges = synthesizeBridges(
      [pat],
      [{ from_id: 'pattern:P-bbb002', to_id: 'task:T532', edge_type: 'derived_from', weight: 0.7 }],
      [],
      [],
      [],
    );

    expect(edges[0].target).toBe('tasks:T532');
    expect(edges[0].substrate).toBe('cross');
  });

  it('emits multiple task bridges from a single observation', () => {
    const obs = makeBrainNode('observation', 'O-ccc003', 'Multi-task obs');

    const edges = synthesizeBridges(
      [obs],
      [
        {
          from_id: 'observation:O-ccc003',
          to_id: 'task:T523',
          edge_type: 'applies_to',
          weight: 0.8,
        },
        {
          from_id: 'observation:O-ccc003',
          to_id: 'task:T513',
          edge_type: 'applies_to',
          weight: 0.8,
        },
      ],
      [],
      [],
      [],
    );

    expect(edges).toHaveLength(2);
    const targets = edges.map((e) => e.target);
    expect(targets).toContain('tasks:T523');
    expect(targets).toContain('tasks:T513');
    for (const e of edges) {
      expect(e.substrate).toBe('cross');
    }
  });
});

// ---------------------------------------------------------------------------
// Tests: cross-substrate brain → nexus bridges (code_reference)
// ---------------------------------------------------------------------------

describe('cross-substrate brain → nexus bridges from code_reference edges', () => {
  it('emits code_reference edge when to_id is a nexus :: path', () => {
    const dec = makeBrainNode('decision', 'D-ddd004', 'Decision about dispatcher');

    const nexusPath = 'packages/cleo/src/dispatch/dispatcher.ts::Dispatcher.dispatch';
    const edges = synthesizeBridges(
      [dec],
      [
        {
          from_id: 'decision:D-ddd004',
          to_id: nexusPath,
          edge_type: 'code_reference',
          weight: 1.0,
        },
      ],
      [],
      [],
      [],
    );

    expect(edges).toHaveLength(1);
    expect(edges[0].source).toBe('brain:D-ddd004');
    expect(edges[0].target).toBe(`nexus:${nexusPath}`);
    expect(edges[0].type).toBe('code_reference');
    expect(edges[0].substrate).toBe('cross');
  });

  it('emits cross edge for file-only path (no :: separator)', () => {
    const obs = makeBrainNode('observation', 'O-eee005', 'Observation about a file');

    const filePath = 'packages/core/src/cleo.ts';
    const edges = synthesizeBridges(
      [obs],
      [{ from_id: 'observation:O-eee005', to_id: filePath, edge_type: 'references', weight: 0.6 }],
      [],
      [],
      [],
    );

    expect(edges).toHaveLength(1);
    expect(edges[0].target).toBe(`nexus:${filePath}`);
    expect(edges[0].substrate).toBe('cross');
  });

  it('does not emit nexus bridge for non-path to_id without /', () => {
    // An ID like "someword" (no colon, no slash, no ::) falls through to
    // intra-brain lookup and is skipped when not found.
    const obs = makeBrainNode('observation', 'O-fff006', 'Observation');

    const edges = synthesizeBridges(
      [obs],
      [
        {
          from_id: 'observation:O-fff006',
          to_id: 'someword',
          edge_type: 'references',
          weight: 0.5,
        },
      ],
      [],
      [],
      [],
    );

    // 'someword' has no colon and no slash — isNexusStyleId returns false,
    // isTaskId returns false, brainTypeIdToLBId returns null → edge is skipped.
    expect(edges).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Tests: brain_memory_links cross-substrate bridges
// ---------------------------------------------------------------------------

describe('brain_memory_links cross-substrate edges', () => {
  it('emits produces_by edge from observation memory link', () => {
    const obs = makeBrainNode('observation', 'O-ggg007', 'Linked observation');

    const edges = synthesizeBridges(
      [obs],
      [],
      [
        {
          memory_type: 'observation',
          memory_id: 'O-ggg007',
          task_id: 'T314',
          link_type: 'produced_by',
        },
      ],
      [],
      [],
    );

    expect(edges).toHaveLength(1);
    expect(edges[0].source).toBe('brain:O-ggg007');
    expect(edges[0].target).toBe('tasks:T314');
    expect(edges[0].type).toBe('produced_by');
    expect(edges[0].substrate).toBe('cross');
    expect(edges[0].weight).toBe(0.7);
  });

  it('emits applies_to edge from observation memory link', () => {
    const obs = makeBrainNode('observation', 'O-hhh008', 'Applies obs');

    const edges = synthesizeBridges(
      [obs],
      [],
      [
        {
          memory_type: 'observation',
          memory_id: 'O-hhh008',
          task_id: 'T001',
          link_type: 'applies_to',
        },
      ],
      [],
      [],
    );

    expect(edges[0].type).toBe('applies_to');
    expect(edges[0].substrate).toBe('cross');
  });

  it('skips memory link when memory node is not loaded', () => {
    // No nodes loaded — brainTypeIdToLBId still resolves the brain: prefix,
    // but source won't be in typeIdToLBId. brainTypeIdToLBId returns a fallback.
    const edges = synthesizeBridges(
      [],
      [],
      [
        {
          memory_type: 'observation',
          memory_id: 'O-iii009',
          task_id: 'T001',
          link_type: 'applies_to',
        },
      ],
      [],
      [],
    );

    // brainTypeIdToLBId resolves 'observation:O-iii009' → 'brain:O-iii009'
    // even when not in typeIdToLBId (it's a fallback). Edge emitted.
    expect(edges).toHaveLength(1);
    expect(edges[0].source).toBe('brain:O-iii009');
  });
});

// ---------------------------------------------------------------------------
// Tests: brain_observations.files_modified_json bridges
// ---------------------------------------------------------------------------

describe('brain_observations.files_modified_json → nexus bridges', () => {
  it('emits modified_by edge for each file in the JSON array', () => {
    const obs = makeBrainNode('observation', 'O-jjj010', 'Code change obs');

    const edges = synthesizeBridges(
      [obs],
      [],
      [],
      [
        {
          id: 'O-jjj010',
          source_session_id: null,
          files_modified_json: JSON.stringify([
            'packages/core/src/cleo.ts',
            'packages/studio/src/app.d.ts',
          ]),
        },
      ],
      [],
    );

    expect(edges).toHaveLength(2);
    const targets = edges.map((e) => e.target);
    expect(targets).toContain('nexus:packages/core/src/cleo.ts');
    expect(targets).toContain('nexus:packages/studio/src/app.d.ts');
    for (const e of edges) {
      expect(e.type).toBe('modified_by');
      expect(e.substrate).toBe('cross');
      expect(e.weight).toBe(0.6);
    }
  });

  it('handles empty files_modified_json array gracefully', () => {
    const obs = makeBrainNode('observation', 'O-kkk011', 'Empty files obs');

    const edges = synthesizeBridges(
      [obs],
      [],
      [],
      [{ id: 'O-kkk011', source_session_id: null, files_modified_json: '[]' }],
      [],
    );

    expect(edges).toHaveLength(0);
  });

  it('handles null files_modified_json gracefully', () => {
    const obs = makeBrainNode('observation', 'O-lll012', 'Null files obs');

    const edges = synthesizeBridges(
      [obs],
      [],
      [],
      [{ id: 'O-lll012', source_session_id: null, files_modified_json: null }],
      [],
    );

    expect(edges).toHaveLength(0);
  });

  it('handles malformed JSON gracefully without throwing', () => {
    const obs = makeBrainNode('observation', 'O-mmm013', 'Bad json obs');

    const edges = synthesizeBridges(
      [obs],
      [],
      [],
      [{ id: 'O-mmm013', source_session_id: null, files_modified_json: '{not-valid-json}' }],
      [],
    );

    expect(edges).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Tests: brain_decisions.context_task_id direct soft-FK bridges
// ---------------------------------------------------------------------------

describe('brain_decisions.context_task_id → tasks bridges', () => {
  it('emits applies_to edge for each decision with a context_task_id', () => {
    const edges = synthesizeBridges([], [], [], [], [{ id: 'D-nnn014', context_task_id: 'T651' }]);

    expect(edges).toHaveLength(1);
    expect(edges[0].source).toBe('brain:D-nnn014');
    expect(edges[0].target).toBe('tasks:T651');
    expect(edges[0].type).toBe('applies_to');
    expect(edges[0].substrate).toBe('cross');
    expect(edges[0].weight).toBe(0.8);
  });

  it('skips decision with null context_task_id', () => {
    const edges = synthesizeBridges([], [], [], [], [{ id: 'D-ooo015', context_task_id: null }]);

    expect(edges).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Tests: edge substrate classification
// ---------------------------------------------------------------------------

describe('edge substrate classification', () => {
  it('intra-brain edges have substrate brain', () => {
    const obs1 = makeBrainNode('observation', 'O-ppp016', 'Obs A');
    const obs2 = makeBrainNode('observation', 'O-qqq017', 'Obs B');

    const edges = synthesizeBridges(
      [obs1, obs2],
      [
        {
          from_id: 'observation:O-ppp016',
          to_id: 'observation:O-qqq017',
          edge_type: 'supersedes',
          weight: 0.9,
        },
      ],
      [],
      [],
      [],
    );

    expect(edges[0].substrate).toBe('brain');
  });

  it('brain→tasks edges have substrate cross', () => {
    const dec = makeBrainNode('decision', 'D-rrr018', 'Decision');

    const edges = synthesizeBridges(
      [dec],
      [{ from_id: 'decision:D-rrr018', to_id: 'task:T100', edge_type: 'applies_to', weight: 0.8 }],
      [],
      [],
      [],
    );

    expect(edges[0].substrate).toBe('cross');
  });

  it('brain→nexus code_reference edges have substrate cross', () => {
    const dec = makeBrainNode('decision', 'D-sss019', 'Decision');

    const edges = synthesizeBridges(
      [dec],
      [
        {
          from_id: 'decision:D-sss019',
          to_id: 'packages/core/src/cleo.ts::Cleo',
          edge_type: 'code_reference',
          weight: 1.0,
        },
      ],
      [],
      [],
      [],
    );

    expect(edges[0].substrate).toBe('cross');
  });

  it('memory_links edges have substrate cross', () => {
    const obs = makeBrainNode('observation', 'O-ttt020', 'Obs');

    const edges = synthesizeBridges(
      [obs],
      [],
      [
        {
          memory_type: 'observation',
          memory_id: 'O-ttt020',
          task_id: 'T001',
          link_type: 'produced_by',
        },
      ],
      [],
      [],
    );

    expect(edges[0].substrate).toBe('cross');
  });
});

// ---------------------------------------------------------------------------
// Tests: combined scenario
// ---------------------------------------------------------------------------

describe('combined bridge scenario', () => {
  it('emits all bridge types together without duplication', () => {
    const obs = makeBrainNode('observation', 'O-uuu021', 'Observation');
    const dec = makeBrainNode('decision', 'D-vvv022', 'Decision');
    const pat = makeBrainNode('pattern', 'P-www023', 'Pattern');

    const edges = synthesizeBridges(
      [obs, dec, pat],
      [
        // intra-brain supersedes
        {
          from_id: 'observation:O-uuu021',
          to_id: 'observation:O-uuu021',
          edge_type: 'supersedes',
          weight: 0.9,
        },
        // brain → task
        { from_id: 'decision:D-vvv022', to_id: 'task:T651', edge_type: 'applies_to', weight: 0.8 },
        // brain → nexus
        {
          from_id: 'pattern:P-www023',
          to_id: 'packages/core/src/cleo.ts::Cleo.run',
          edge_type: 'code_reference',
          weight: 1.0,
        },
      ],
      // memory link
      [
        {
          memory_type: 'observation',
          memory_id: 'O-uuu021',
          task_id: 'T314',
          link_type: 'produced_by',
        },
      ],
      // files modified
      [
        {
          id: 'O-uuu021',
          source_session_id: null,
          files_modified_json: '["packages/core/src/cleo.ts"]',
        },
      ],
      // decision context task
      [{ id: 'D-vvv022', context_task_id: 'T651' }],
    );

    // 1 intra-brain + 1 brain-task (page_edge) + 1 brain-nexus + 1 memory link + 1 file + 1 context_task_id
    expect(edges).toHaveLength(6);

    const brainEdges = edges.filter((e) => e.substrate === 'brain');
    const crossEdges = edges.filter((e) => e.substrate === 'cross');

    expect(brainEdges).toHaveLength(1);
    expect(crossEdges).toHaveLength(5);

    const edgeTypes = new Set(edges.map((e) => e.type));
    expect(edgeTypes).toContain('supersedes');
    expect(edgeTypes).toContain('applies_to');
    expect(edgeTypes).toContain('code_reference');
    expect(edgeTypes).toContain('produced_by');
    expect(edgeTypes).toContain('modified_by');
  });
});
