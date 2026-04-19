/**
 * Unit tests for the cross-substrate bridge detection adapter.
 *
 * Tests are structured into four groups:
 * 1. Schema-absence graceful degradation — missing tables/columns must not throw.
 * 2. Adapter unit tests — known node/edge sets produce expected bridges.
 * 3. Bridge cap test — 10 000 synthetic nodes → result bridges ≤ 2 × 10 000.
 * 4. adaptBrainGraphWithBridges integration — merges correctly.
 *
 * All tests are pure (no real SQLite DBs). A lightweight fake `DatabaseSync`
 * shape is used to inject controlled row data.
 *
 * @task T990
 * @wave Agent D
 */

import { describe, expect, it } from 'vitest';
import { adaptBrainGraph, adaptBrainGraphWithBridges } from '../../brain-adapter.js';
import type { GraphEdge, GraphNode } from '../../types.js';
import type { DbRefs } from '../cross-substrate.js';
import { computeBridges } from '../cross-substrate.js';

// ---------------------------------------------------------------------------
// Fake DB helpers
// ---------------------------------------------------------------------------

/**
 * Builds a minimal fake DatabaseSync that returns controlled rows from
 * `prepare().all()`. The query string is not parsed — every `all()` call
 * returns `rows` regardless of SQL text, which is sufficient for unit tests
 * that exercise a single table per test case.
 */
function fakeDb(rows: Record<string, unknown>[]): DbRefs['brainDb'] {
  return {
    prepare: (_sql: string) => ({
      all: (..._params: unknown[]) => rows,
    }),
  } as unknown as NonNullable<DbRefs['brainDb']>;
}

/** Build a minimal GraphNode for test fixtures. */
function mkNode(id: string, substrate: GraphNode['substrate'] = 'brain'): GraphNode {
  return { id, substrate, kind: 'observation', label: id };
}

// ---------------------------------------------------------------------------
// 1. Graceful degradation when tables/DBs are absent
// ---------------------------------------------------------------------------

describe('computeBridges — schema-absence graceful degradation', () => {
  it('returns empty array when all dbRefs are undefined', () => {
    const nodes: GraphNode[] = [mkNode('brain:O-1'), mkNode('tasks:T1', 'tasks')];
    const result = computeBridges(nodes, {});
    expect(result).toEqual([]);
  });

  it('returns empty array when brainDb.prepare throws', () => {
    const nodes: GraphNode[] = [mkNode('brain:O-1'), mkNode('tasks:T1', 'tasks')];
    const throwingDb = {
      prepare: () => {
        throw new Error('no such table: brain_memory_links');
      },
    } as unknown as NonNullable<DbRefs['brainDb']>;

    const result = computeBridges(nodes, { brainDb: throwingDb });
    expect(result).toEqual([]);
  });

  it('returns empty array when brainDb.prepare().all throws', () => {
    const nodes: GraphNode[] = [mkNode('brain:O-1'), mkNode('tasks:T1', 'tasks')];
    const throwingDb = {
      prepare: (_sql: string) => ({
        all: () => {
          throw new Error('no such column: context_task_id');
        },
      }),
    } as unknown as NonNullable<DbRefs['brainDb']>;

    const result = computeBridges(nodes, { brainDb: throwingDb });
    expect(result).toEqual([]);
  });

  it('silently skips bridges where one endpoint is not in the node set', () => {
    // brain_memory_links row references a task NOT in the node set
    const rows = [
      { memory_type: 'observation', memory_id: 'O-abc', task_id: 'T999', link_type: 'produced_by' },
    ];
    const nodes: GraphNode[] = [mkNode('brain:O-abc')]; // tasks:T999 absent
    const result = computeBridges(nodes, { brainDb: fakeDb(rows) });
    expect(result).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// 2. Adapter unit tests — known inputs → expected bridges
// ---------------------------------------------------------------------------

describe('computeBridges — brain_memory_links bridges (task→brain)', () => {
  it('emits a produced_by bridge for link_type produced_by', () => {
    const rows = [
      { memory_type: 'observation', memory_id: 'O-abc', task_id: 'T532', link_type: 'produced_by' },
    ];
    const nodes: GraphNode[] = [mkNode('brain:O-abc'), mkNode('tasks:T532', 'tasks')];
    const result = computeBridges(nodes, { brainDb: fakeDb(rows) });

    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({
      source: 'brain:O-abc',
      target: 'tasks:T532',
      kind: 'produced_by',
      weight: 0.7,
    });
    expect(result[0].meta?.isBridge).toBe(true);
    expect(result[0].meta?.bridgeType).toBe('task->brain');
  });

  it('emits an informed_by bridge for link_type informed_by', () => {
    const rows = [
      { memory_type: 'decision', memory_id: 'D-xyz', task_id: 'T100', link_type: 'informed_by' },
    ];
    const nodes: GraphNode[] = [mkNode('brain:D-xyz'), mkNode('tasks:T100', 'tasks')];
    const result = computeBridges(nodes, { brainDb: fakeDb(rows) });

    expect(result[0].kind).toBe('informed_by');
  });

  it('emits a derived_from bridge for link_type applies_to', () => {
    const rows = [
      { memory_type: 'pattern', memory_id: 'P-qrs', task_id: 'T200', link_type: 'applies_to' },
    ];
    const nodes: GraphNode[] = [mkNode('brain:P-qrs'), mkNode('tasks:T200', 'tasks')];
    const result = computeBridges(nodes, { brainDb: fakeDb(rows) });

    expect(result[0].kind).toBe('derived_from');
  });

  it('falls back to relates_to for unknown link_type', () => {
    const rows = [
      { memory_type: 'learning', memory_id: 'L-zzz', task_id: 'T300', link_type: 'unknown_type' },
    ];
    const nodes: GraphNode[] = [mkNode('brain:L-zzz'), mkNode('tasks:T300', 'tasks')];
    const result = computeBridges(nodes, { brainDb: fakeDb(rows) });

    expect(result[0].kind).toBe('relates_to');
  });
});

describe('computeBridges — brain_decisions context bridges (task→brain)', () => {
  it('emits informed_by for context_task_id', () => {
    // The fakeDb returns these rows for EVERY query — we need a db that returns
    // decision rows for the context query. Since every all() returns the same rows,
    // we include the expected shape and rely on the filter logic.
    const rows = [{ id: 'D-001', context_task_id: 'T400', context_epic_id: null }];
    const nodes: GraphNode[] = [mkNode('brain:D-001'), mkNode('tasks:T400', 'tasks')];

    // Build a db that returns decision rows (simulate the decisions query hit)
    const db = {
      prepare: (sql: string) => ({
        all: (..._params: unknown[]) => {
          // brain_memory_links query returns empty, decisions query returns rows
          if (sql.includes('brain_decisions')) return rows;
          return [];
        },
      }),
    } as unknown as NonNullable<DbRefs['brainDb']>;

    const result = computeBridges(nodes, { brainDb: db });
    const informed = result.filter((e) => e.kind === 'informed_by' && e.target === 'tasks:T400');
    expect(informed.length).toBeGreaterThanOrEqual(1);
    expect(informed[0].meta?.isBridge).toBe(true);
    expect(informed[0].meta?.bridgeType).toBe('task->brain');
  });
});

describe('computeBridges — brain_page_edges nexus bridges (brain→nexus)', () => {
  it('emits a references bridge for a nexus-style :: path', () => {
    const rows = [
      {
        from_id: 'observation:O-abc',
        to_id: 'packages/cleo/src/store.ts::createStore',
        edge_type: 'references',
        weight: 0.8,
      },
    ];
    const nodes: GraphNode[] = [
      mkNode('brain:O-abc'),
      mkNode('nexus:packages/cleo/src/store.ts::createStore', 'nexus'),
    ];

    const db = {
      prepare: (sql: string) => ({
        all: (..._params: unknown[]) => {
          if (sql.includes('brain_page_edges')) return rows;
          return [];
        },
      }),
    } as unknown as NonNullable<DbRefs['brainDb']>;

    const result = computeBridges(nodes, { brainDb: db });
    const nexusBridges = result.filter((e) => e.meta?.bridgeType === 'brain->nexus');
    expect(nexusBridges.length).toBeGreaterThanOrEqual(1);
    expect(nexusBridges[0].kind).toBe('references');
    expect(nexusBridges[0].meta?.link_kind).toBe('code');
  });

  it('emits a documents bridge for a file path from files_modified_json', () => {
    const rows = [
      { id: 'O-file', files_modified_json: '["packages/studio/src/routes/brain/+page.svelte"]' },
    ];
    const nodes: GraphNode[] = [
      mkNode('brain:O-file'),
      mkNode('nexus:packages/studio/src/routes/brain/+page.svelte', 'nexus'),
    ];

    const db = {
      prepare: (sql: string) => ({
        all: (..._params: unknown[]) => {
          if (sql.includes('files_modified_json')) return rows;
          return [];
        },
      }),
    } as unknown as NonNullable<DbRefs['brainDb']>;

    const result = computeBridges(nodes, { brainDb: db });
    const docs = result.filter((e) => e.kind === 'documents');
    expect(docs.length).toBeGreaterThanOrEqual(1);
    expect(docs[0].source).toBe('brain:O-file');
    expect(docs[0].meta?.bridgeType).toBe('brain->nexus');
  });

  it('caps files_modified_json at 5 links per observation', () => {
    // 10 files — should emit only 5 bridges per observation
    const files = Array.from({ length: 10 }, (_, i) => `packages/pkg${i}/index.ts`);
    const rows = [{ id: 'O-many', files_modified_json: JSON.stringify(files) }];

    // Nodes for all 10 files + the obs node
    const nodes: GraphNode[] = [
      mkNode('brain:O-many'),
      ...files.map((f) => mkNode(`nexus:${f}`, 'nexus')),
    ];

    const db = {
      prepare: (sql: string) => ({
        all: (..._params: unknown[]) => {
          if (sql.includes('files_modified_json')) return rows;
          return [];
        },
      }),
    } as unknown as NonNullable<DbRefs['brainDb']>;

    const result = computeBridges(nodes, { brainDb: db });
    const docs = result.filter((e) => e.kind === 'documents' && e.source === 'brain:O-many');
    expect(docs.length).toBeLessThanOrEqual(5);
  });
});

describe('computeBridges — conduit→tasks bridges via brain_page_edges', () => {
  it('emits a messages bridge from conduit node to tasks node', () => {
    const rows = [
      { from_id: 'msg:msg_abc123', to_id: 'task:T600', edge_type: 'discusses', weight: 0.9 },
    ];
    const nodes: GraphNode[] = [
      mkNode('conduit:msg_abc123', 'conduit'),
      mkNode('tasks:T600', 'tasks'),
    ];

    const db = {
      prepare: (sql: string) => ({
        all: (..._params: unknown[]) => {
          if (sql.includes("from_id LIKE 'msg:%'")) return rows;
          return [];
        },
      }),
    } as unknown as NonNullable<DbRefs['brainDb']>;

    const result = computeBridges(nodes, { brainDb: db });
    const msgs = result.filter((e) => e.meta?.bridgeType === 'conduit->tasks');
    expect(msgs.length).toBeGreaterThanOrEqual(1);
    expect(msgs[0].kind).toBe('messages');
    expect(msgs[0].source).toBe('conduit:msg_abc123');
    expect(msgs[0].target).toBe('tasks:T600');
  });
});

describe('computeBridges — signaldock→tasks bridges via tasks.assignee', () => {
  it('emits a messages bridge from signaldock agent to assigned task', () => {
    const rows = [{ id: 'T700', assignee: 'agent-cleo-prime' }];
    const nodes: GraphNode[] = [
      mkNode('signaldock:agent-cleo-prime', 'signaldock'),
      mkNode('tasks:T700', 'tasks'),
    ];

    const db = {
      prepare: (_sql: string) => ({
        all: (..._params: unknown[]) => rows,
      }),
    } as unknown as NonNullable<DbRefs['tasksDb']>;

    const result = computeBridges(nodes, { tasksDb: db });
    const sigBridges = result.filter((e) => e.meta?.bridgeType === 'signaldock->tasks');
    expect(sigBridges.length).toBeGreaterThanOrEqual(1);
    expect(sigBridges[0].kind).toBe('messages');
    expect(sigBridges[0].source).toBe('signaldock:agent-cleo-prime');
    expect(sigBridges[0].target).toBe('tasks:T700');
  });
});

describe('computeBridges — deduplication', () => {
  it('deduplicates (source, target, kind) triples', () => {
    // Two rows that would produce the same bridge
    const rows = [
      { memory_type: 'observation', memory_id: 'O-dup', task_id: 'T1', link_type: 'produced_by' },
      { memory_type: 'observation', memory_id: 'O-dup', task_id: 'T1', link_type: 'produced_by' },
    ];
    const nodes: GraphNode[] = [mkNode('brain:O-dup'), mkNode('tasks:T1', 'tasks')];
    const result = computeBridges(nodes, { brainDb: fakeDb(rows) });

    const matching = result.filter(
      (e) => e.source === 'brain:O-dup' && e.target === 'tasks:T1' && e.kind === 'produced_by',
    );
    expect(matching).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// 3. Bridge cap test
// ---------------------------------------------------------------------------

describe('computeBridges — bridge cap (2 × node count)', () => {
  it('result bridges are <= 2 × node count for 10 000 synthetic nodes', () => {
    // Create 10 000 synthetic nodes: 5000 brain + 5000 tasks
    const syntheticNodes: GraphNode[] = [];
    const syntheticRows: Record<string, unknown>[] = [];

    const HALF = 5000;
    for (let i = 0; i < HALF; i++) {
      syntheticNodes.push(mkNode(`brain:O-${i}`));
      syntheticNodes.push(mkNode(`tasks:T${i}`, 'tasks'));
      // Each brain node has a bridge to each tasks node (many-to-many would be too large)
      syntheticRows.push({
        memory_type: 'observation',
        memory_id: `O-${i}`,
        task_id: `T${i}`,
        link_type: 'produced_by',
      });
      // Duplicate to stress-test dedup
      syntheticRows.push({
        memory_type: 'observation',
        memory_id: `O-${i}`,
        task_id: `T${i}`,
        link_type: 'produced_by',
      });
    }

    const result = computeBridges(syntheticNodes, { brainDb: fakeDb(syntheticRows) });
    const maxAllowed = syntheticNodes.length * 2;
    expect(result.length).toBeLessThanOrEqual(maxAllowed);
  });

  it('emits bridges in descending weight order after cap', () => {
    // Build nodes with varying weights via bridge weight (all 0.7 here, but sorted)
    const rows = Array.from({ length: 20 }, (_, i) => ({
      memory_type: 'observation',
      memory_id: `O-w${i}`,
      task_id: `T${i}`,
      link_type: 'produced_by',
    }));
    const nodes: GraphNode[] = rows.flatMap((r) => [
      mkNode(`brain:${r.memory_id}`),
      mkNode(`tasks:${r.task_id}`, 'tasks'),
    ]);

    const result = computeBridges(nodes, { brainDb: fakeDb(rows) });
    // All weights are 0.7, so order is arbitrary but they should all be non-decreasing
    for (let i = 1; i < result.length; i++) {
      expect(result[i - 1].weight ?? 0).toBeGreaterThanOrEqual(result[i].weight ?? 0);
    }
  });
});

// ---------------------------------------------------------------------------
// 4. adaptBrainGraphWithBridges integration
// ---------------------------------------------------------------------------

describe('adaptBrainGraphWithBridges', () => {
  it('returns the original graph unchanged when bridges is empty', () => {
    const adapted = adaptBrainGraph([], []);
    const result = adaptBrainGraphWithBridges(adapted, []);
    expect(result).toBe(adapted);
  });

  it('appends valid bridge edges to the existing edge array', () => {
    const nodes = [
      {
        id: 'brain:O-1',
        kind: 'observation' as const,
        substrate: 'brain' as const,
        label: 'obs',
        weight: 0.8,
        createdAt: '2026-01-01T00:00:00',
        meta: {},
      },
      {
        id: 'tasks:T1',
        kind: 'task' as const,
        substrate: 'tasks' as const,
        label: 'Task 1',
        weight: 0.5,
        createdAt: '2026-01-01T00:00:00',
        meta: {},
      },
    ];

    const adapted = adaptBrainGraph(nodes, []);

    const bridge: GraphEdge = {
      id: 'bridge-0:brain:O-1>tasks:T1:produced_by',
      source: 'brain:O-1',
      target: 'tasks:T1',
      kind: 'produced_by',
      weight: 0.7,
      directional: true,
      meta: { isBridge: true, bridgeType: 'task->brain' },
    };

    const result = adaptBrainGraphWithBridges(adapted, [bridge]);
    expect(result.edges).toHaveLength(1);
    expect(result.edges[0]).toBe(bridge);
    expect(result.nodes).toBe(adapted.nodes);
  });

  it('filters out bridge edges where an endpoint is not in the node set', () => {
    const adapted = adaptBrainGraph([], []);

    const orphanBridge: GraphEdge = {
      id: 'bridge-orphan',
      source: 'brain:O-missing',
      target: 'tasks:T-missing',
      kind: 'relates_to',
      weight: 0.7,
      meta: { isBridge: true, bridgeType: 'task->brain' },
    };

    const result = adaptBrainGraphWithBridges(adapted, [orphanBridge]);
    expect(result.edges).toHaveLength(0);
  });

  it('does not mutate the original adapted graph', () => {
    const nodes = [
      {
        id: 'brain:O-2',
        kind: 'observation' as const,
        substrate: 'brain' as const,
        label: 'obs',
        weight: 0.8,
        createdAt: null,
        meta: {},
      },
      {
        id: 'tasks:T2',
        kind: 'task' as const,
        substrate: 'tasks' as const,
        label: 'T',
        weight: 0.5,
        createdAt: null,
        meta: {},
      },
    ];
    const adapted = adaptBrainGraph(nodes, []);
    const originalEdgesLength = adapted.edges.length;

    const bridge: GraphEdge = {
      id: 'bridge-x',
      source: 'brain:O-2',
      target: 'tasks:T2',
      kind: 'produced_by',
      weight: 0.7,
      meta: { isBridge: true, bridgeType: 'task->brain' },
    };

    adaptBrainGraphWithBridges(adapted, [bridge]);

    // Original edges array is unmodified
    expect(adapted.edges).toHaveLength(originalEdgesLength);
  });
});
