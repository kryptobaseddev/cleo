/**
 * Integration tests for brain-page-nodes.ts — T945 sentience layer SDK.
 *
 * Covers:
 * - getRelated: 1-hop neighbour traversal (with and without edge-type filter)
 * - getImpact: BFS impact analysis (bidirectional and directional)
 * - getContext: 360-degree node context view
 * - materializeXfkEdges: XFKB-001..004 promotion to hard graph edges
 * - queryGraphNodes: sentience-layer node query + `msg` → `conduit_message` mapping
 * - validateEdgeTypes: canonical edge type validation
 * - listEdgeTypes: enumerate present edge types
 * - checkNexusForeignKeys: returns 0 when nexus.db is unavailable
 *
 * @task T945
 * @epic T1056
 */

import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Force real module implementations — prevent leaks from other test shards.
vi.mock('../../paths.js', async () => await vi.importActual('../../paths.js'));
vi.mock(
  '../../store/memory-sqlite.js',
  async () => await vi.importActual('../../store/memory-sqlite.js'),
);
vi.mock('../../config.js', async () => await vi.importActual('../../config.js'));

let tempDir: string;
let cleoDir: string;

beforeEach(async () => {
  tempDir = await mkdtemp(join(tmpdir(), 'cleo-brain-page-nodes-'));
  cleoDir = join(tempDir, '.cleo');
  await mkdir(cleoDir, { recursive: true });
  process.env['CLEO_DIR'] = cleoDir;
  process.env['CLEO_HOME'] = cleoDir;
  // Enable autoCapture so graph writes fire.
  await writeFile(join(cleoDir, 'config.json'), JSON.stringify({ brain: { autoCapture: true } }));
});

afterEach(async () => {
  const { closeBrainDb } = await import('../../store/memory-sqlite.js');
  closeBrainDb();
  delete process.env['CLEO_DIR'];
  delete process.env['CLEO_HOME'];
  await rm(tempDir, { recursive: true, force: true });
  vi.restoreAllMocks();
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Seed the graph with a set of nodes and edges for traversal tests. */
async function seedGraph(projectRoot: string): Promise<void> {
  const { getBrainDb } = await import('../../store/memory-sqlite.js');
  const { brainPageEdges, brainPageNodes } = await import('../../store/memory-schema.js');

  const db = await getBrainDb(projectRoot);
  const now = new Date().toISOString().replace('T', ' ').slice(0, 19);

  // Seed nodes: task, decision, observation, msg (conduit_message)
  await db
    .insert(brainPageNodes)
    .values([
      {
        id: 'task:T001',
        nodeType: 'task',
        label: 'Task T001',
        qualityScore: 0.9,
        contentHash: null,
        lastActivityAt: now,
        createdAt: now,
        updatedAt: now,
      },
      {
        id: 'decision:D-001',
        nodeType: 'decision',
        label: 'Decision D-001',
        qualityScore: 0.8,
        contentHash: null,
        lastActivityAt: now,
        createdAt: now,
        updatedAt: now,
      },
      {
        id: 'observation:O-001',
        nodeType: 'observation',
        label: 'Observation O-001',
        qualityScore: 0.7,
        contentHash: null,
        lastActivityAt: now,
        createdAt: now,
        updatedAt: now,
      },
      {
        id: 'msg:msg_abc',
        nodeType: 'msg',
        label: 'Conduit message abc',
        qualityScore: 0.5,
        contentHash: null,
        lastActivityAt: now,
        createdAt: now,
        updatedAt: now,
      },
    ])
    .onConflictDoNothing();

  // Seed edges:
  // task:T001 → applies_to → decision:D-001
  // decision:D-001 → documents → observation:O-001
  // msg:msg_abc → discusses → task:T001
  await db
    .insert(brainPageEdges)
    .values([
      {
        fromId: 'task:T001',
        toId: 'decision:D-001',
        edgeType: 'applies_to',
        weight: 1.0,
        provenance: 'test',
        createdAt: now,
      },
      {
        fromId: 'decision:D-001',
        toId: 'observation:O-001',
        edgeType: 'documents',
        weight: 0.9,
        provenance: 'test',
        createdAt: now,
      },
      {
        fromId: 'msg:msg_abc',
        toId: 'task:T001',
        edgeType: 'discusses',
        weight: 0.8,
        provenance: 'test',
        createdAt: now,
      },
    ])
    .onConflictDoNothing();
}

// ---------------------------------------------------------------------------
// getRelated
// ---------------------------------------------------------------------------

describe('getRelated', () => {
  it('returns all 1-hop neighbours of a node', async () => {
    const { getRelated } = await import('../brain-page-nodes.js');
    await seedGraph(tempDir);

    const related = await getRelated(tempDir, 'task:T001');

    // task:T001 is the source for applies_to → decision:D-001 (outgoing)
    // task:T001 is the target for discusses ← msg:msg_abc (incoming)
    const ids = related.map((r) => r.node.id).sort();
    expect(ids).toContain('decision:D-001');
    expect(ids).toContain('msg:msg_abc');
  });

  it('filters by edge type when edgeType is supplied', async () => {
    const { getRelated } = await import('../brain-page-nodes.js');
    await seedGraph(tempDir);

    const related = await getRelated(tempDir, 'task:T001', { edgeType: 'applies_to' });

    expect(related).toHaveLength(1);
    expect(related[0]?.node.id).toBe('decision:D-001');
    expect(related[0]?.edgeType).toBe('applies_to');
  });

  it('respects the limit parameter', async () => {
    const { getRelated } = await import('../brain-page-nodes.js');
    await seedGraph(tempDir);

    const related = await getRelated(tempDir, 'decision:D-001', { limit: 1 });
    expect(related).toHaveLength(1);
  });

  it('returns empty array for unknown node ID', async () => {
    const { getRelated } = await import('../brain-page-nodes.js');
    const related = await getRelated(tempDir, 'task:NONEXISTENT');
    expect(related).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// getImpact
// ---------------------------------------------------------------------------

describe('getImpact', () => {
  it('returns BFS reachable nodes from a seed', async () => {
    const { getImpact } = await import('../brain-page-nodes.js');
    await seedGraph(tempDir);

    const impact = await getImpact(tempDir, 'task:T001', { maxDepth: 3 });

    // Seed itself + decision:D-001 + observation:O-001 + msg:msg_abc
    const ids = impact.map((n) => n.id);
    expect(ids).toContain('task:T001');
    expect(ids).toContain('decision:D-001');
    expect(ids).toContain('observation:O-001');
  });

  it('seed node is included at depth 0', async () => {
    const { getImpact } = await import('../brain-page-nodes.js');
    await seedGraph(tempDir);

    const impact = await getImpact(tempDir, 'task:T001');
    const seed = impact.find((n) => n.id === 'task:T001');
    expect(seed?.depth).toBe(0);
  });

  it('respects maxDepth (depth 1 returns direct neighbours only)', async () => {
    const { getImpact } = await import('../brain-page-nodes.js');
    await seedGraph(tempDir);

    const impact = await getImpact(tempDir, 'task:T001', { maxDepth: 1 });
    const depths = impact.map((n) => n.depth);
    expect(Math.max(...depths)).toBeLessThanOrEqual(1);
  });

  it('returns empty array for unknown node ID', async () => {
    const { getImpact } = await import('../brain-page-nodes.js');
    const impact = await getImpact(tempDir, 'task:NONEXISTENT');
    expect(impact).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// getContext
// ---------------------------------------------------------------------------

describe('getContext', () => {
  it('returns full context for an existing node', async () => {
    const { getContext } = await import('../brain-page-nodes.js');
    await seedGraph(tempDir);

    const ctx = await getContext(tempDir, 'decision:D-001');

    expect(ctx).not.toBeNull();
    expect(ctx?.node.id).toBe('decision:D-001');
    // decision:D-001 has one outgoing edge (documents → observation)
    // and one incoming edge (applies_to ← task:T001)
    const outTypes = ctx?.outEdges.map((e) => e.edgeType).sort();
    const inTypes = ctx?.inEdges.map((e) => e.edgeType).sort();
    expect(outTypes).toContain('documents');
    expect(inTypes).toContain('applies_to');
  });

  it('returns null for an unknown node ID', async () => {
    const { getContext } = await import('../brain-page-nodes.js');
    const ctx = await getContext(tempDir, 'task:NONEXISTENT');
    expect(ctx).toBeNull();
  });

  it('populates neighbors array', async () => {
    const { getContext } = await import('../brain-page-nodes.js');
    await seedGraph(tempDir);

    const ctx = await getContext(tempDir, 'task:T001');
    expect(ctx?.neighbors.length).toBeGreaterThan(0);
    const neighbourIds = ctx?.neighbors.map((n) => n.node.id) ?? [];
    expect(neighbourIds).toContain('decision:D-001');
  });
});

// ---------------------------------------------------------------------------
// materializeXfkEdges
// ---------------------------------------------------------------------------

describe('materializeXfkEdges', () => {
  it('materializes brain_decisions.context_task_id as applies_to edges (XFKB-002)', async () => {
    const { materializeXfkEdges } = await import('../brain-page-nodes.js');
    const { getBrainDb } = await import('../../store/memory-sqlite.js');
    const { brainDecisions } = await import('../../store/memory-schema.js');

    // Insert a decision with a context_task_id
    const db = await getBrainDb(tempDir);
    const now = new Date().toISOString().replace('T', ' ').slice(0, 19);
    await db.insert(brainDecisions).values({
      id: 'D-xfkb-test',
      type: 'technical',
      decision: 'Test decision for XFKB-002',
      rationale: 'rationale text',
      confidence: 'medium',
      outcome: null,
      contextTaskId: 'T500',
      contextEpicId: null,
      peerId: 'global',
      qualityScore: 0.7,
      createdAt: now,
      updatedAt: now,
    });

    const result = await materializeXfkEdges(tempDir);

    expect(result.decisionToTask).toBeGreaterThan(0);
    expect(result.total).toBeGreaterThan(0);

    // Verify the edge exists in brain_page_edges
    const { getBrainNativeDb } = await import('../../store/memory-sqlite.js');
    const nativeDb = getBrainNativeDb();
    const edge = nativeDb
      ?.prepare(
        `SELECT * FROM brain_page_edges
         WHERE from_id = 'decision:D-xfkb-test' AND to_id = 'task:T500'
         AND edge_type = 'applies_to'`,
      )
      .get();
    expect(edge).toBeDefined();
  });

  it('materializes brain_observations.source_session_id as produced_by edges (XFKB-004)', async () => {
    const { materializeXfkEdges } = await import('../brain-page-nodes.js');
    const { getBrainDb, getBrainNativeDb } = await import('../../store/memory-sqlite.js');
    const { brainObservations } = await import('../../store/memory-schema.js');

    // Insert an observation with a source_session_id using Drizzle ORM
    const db = await getBrainDb(tempDir);
    const now = new Date().toISOString().replace('T', ' ').slice(0, 19);
    await db.insert(brainObservations).values({
      id: 'O-xfkb-obs-01',
      type: 'discovery',
      title: 'XFKB obs',
      narrative: 'narrative text',
      sourceType: 'agent',
      qualityScore: 0.6,
      peerId: 'global',
      sourceSessionId: 'ses_20260401_abc',
      createdAt: now,
      updatedAt: now,
    });

    const result = await materializeXfkEdges(tempDir);

    expect(result.observationToSession).toBeGreaterThan(0);

    const nativeDb = getBrainNativeDb();
    const edge = nativeDb
      ?.prepare(
        `SELECT * FROM brain_page_edges
         WHERE from_id = 'observation:O-xfkb-obs-01' AND to_id = 'session:ses_20260401_abc'
         AND edge_type = 'produced_by'`,
      )
      .get();
    expect(edge).toBeDefined();
  });

  it('is idempotent — calling twice does not create duplicate edges', async () => {
    const { materializeXfkEdges } = await import('../brain-page-nodes.js');
    const { getBrainDb } = await import('../../store/memory-sqlite.js');
    const { brainDecisions } = await import('../../store/memory-schema.js');

    const db = await getBrainDb(tempDir);
    const now = new Date().toISOString().replace('T', ' ').slice(0, 19);
    await db.insert(brainDecisions).values({
      id: 'D-idem-test',
      type: 'architecture',
      decision: 'Idempotent test decision',
      rationale: 'test rationale',
      confidence: 'high',
      outcome: null,
      contextTaskId: 'T501',
      contextEpicId: null,
      peerId: 'global',
      qualityScore: 0.8,
      createdAt: now,
      updatedAt: now,
    });

    await materializeXfkEdges(tempDir);
    await materializeXfkEdges(tempDir); // Second call — must not error or duplicate

    const { getBrainNativeDb } = await import('../../store/memory-sqlite.js');
    const nativeDb = getBrainNativeDb();
    const edges = nativeDb
      ?.prepare(
        `SELECT COUNT(*) AS cnt FROM brain_page_edges
         WHERE from_id = 'decision:D-idem-test' AND to_id = 'task:T501'
         AND edge_type = 'applies_to'`,
      )
      .get() as { cnt: number } | undefined;

    expect(edges?.cnt).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// queryGraphNodes
// ---------------------------------------------------------------------------

describe('queryGraphNodes', () => {
  it('returns nodes of the sentience types only', async () => {
    const { queryGraphNodes } = await import('../brain-page-nodes.js');
    await seedGraph(tempDir);

    const result = await queryGraphNodes(tempDir);

    const types = [...new Set(result.nodes.map((n) => n.type))];
    // All returned types should be in the expected sentience set
    for (const t of types) {
      expect(['task', 'decision', 'observation', 'symbol', 'conduit_message', 'llmtxt']).toContain(
        t,
      );
    }
  });

  it('maps internal msg type to conduit_message in the response', async () => {
    const { queryGraphNodes } = await import('../brain-page-nodes.js');
    await seedGraph(tempDir);

    const result = await queryGraphNodes(tempDir);
    const msgNode = result.nodes.find((n) => n.id === 'msg:msg_abc');
    expect(msgNode).toBeDefined();
    expect(msgNode?.type).toBe('conduit_message');
  });

  it('returns non-empty nodes for each seeded type', async () => {
    const { queryGraphNodes } = await import('../brain-page-nodes.js');
    await seedGraph(tempDir);

    const result = await queryGraphNodes(tempDir);
    expect(result.nodes.length).toBeGreaterThan(0);
    expect(result.totalNodes).toBeGreaterThan(0);

    // Each seeded node type should appear
    const ids = result.nodes.map((n) => n.id);
    expect(ids).toContain('task:T001');
    expect(ids).toContain('decision:D-001');
    expect(ids).toContain('observation:O-001');
    expect(ids).toContain('msg:msg_abc');
  });

  it('only includes edges where both endpoints are in the returned set', async () => {
    const { queryGraphNodes } = await import('../brain-page-nodes.js');
    await seedGraph(tempDir);

    const result = await queryGraphNodes(tempDir);
    const nodeIds = new Set(result.nodes.map((n) => n.id));

    for (const edge of result.edges) {
      expect(nodeIds.has(edge.fromId)).toBe(true);
      expect(nodeIds.has(edge.toId)).toBe(true);
    }
  });

  it('returns empty result when brain.db does not exist', async () => {
    // Use a fresh dir with no brain.db initialized
    const { mkdtemp } = await import('node:fs/promises');
    const { tmpdir } = await import('node:os');
    const emptyDir = await mkdtemp(join(tmpdir(), 'cleo-empty-'));
    await mkdir(join(emptyDir, '.cleo'), { recursive: true });

    const { queryGraphNodes: qgn } = await import('../brain-page-nodes.js');
    const result = await qgn(emptyDir);
    expect(result.nodes).toEqual([]);
    expect(result.edges).toEqual([]);

    await rm(emptyDir, { recursive: true, force: true });
  });
});

// ---------------------------------------------------------------------------
// listEdgeTypes / validateEdgeTypes
// ---------------------------------------------------------------------------

describe('listEdgeTypes', () => {
  it('returns the edge types present in the graph after seeding', async () => {
    const { listEdgeTypes } = await import('../brain-page-nodes.js');
    await seedGraph(tempDir);

    const types = await listEdgeTypes(tempDir);
    expect(types).toContain('applies_to');
    expect(types).toContain('documents');
    expect(types).toContain('discusses');
  });

  it('returns empty array when no edges exist', async () => {
    const { listEdgeTypes } = await import('../brain-page-nodes.js');
    // Initialize brain.db but add no edges
    const { getBrainDb } = await import('../../store/memory-sqlite.js');
    await getBrainDb(tempDir); // initializes schema

    const types = await listEdgeTypes(tempDir);
    expect(types).toEqual([]);
  });
});

describe('validateEdgeTypes', () => {
  it('returns empty array when all edge types are canonical', async () => {
    const { validateEdgeTypes } = await import('../brain-page-nodes.js');
    await seedGraph(tempDir);

    const nonCanonical = await validateEdgeTypes(tempDir);
    expect(nonCanonical).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// checkNexusForeignKeys
// ---------------------------------------------------------------------------

describe('checkNexusForeignKeys', () => {
  it('returns 0 when nexus.db is not available', async () => {
    const { checkNexusForeignKeys } = await import('../brain-page-nodes.js');
    // nexus.db is not initialized in the temp dir — should return 0 gracefully
    const count = await checkNexusForeignKeys();
    expect(count).toBe(0);
  });
});
