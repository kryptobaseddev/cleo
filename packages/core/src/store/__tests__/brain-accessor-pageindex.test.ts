/**
 * Tests for PageIndex accessor methods on BrainDataAccessor.
 *
 * Validates addPageNode, getPageNode, findPageNodes, removePageNode,
 * addPageEdge, getPageEdges, getNeighbors, and removePageEdge using
 * in-memory brain.db instances.
 *
 * Updated for T528: uses expanded BRAIN_NODE_TYPES and BRAIN_EDGE_TYPES.
 * Old values mapped per T528 cross-validation report:
 *   'doc' → 'concept', 'depends_on' → 'derived_from', 'relates_to' → 'informed_by'
 *
 * @epic T5149
 * @task T5384
 */

import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

let tempDir: string;
let cleoDir: string;

describe('BrainDataAccessor PageIndex', () => {
  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'cleo-brain-pageindex-accessor-'));
    cleoDir = join(tempDir, '.cleo');
    process.env['CLEO_DIR'] = cleoDir;
  });

  afterEach(async () => {
    const { closeBrainDb } = await import('../brain-sqlite.js');
    closeBrainDb();
    delete process.env['CLEO_DIR'];
    await rm(tempDir, { recursive: true, force: true });
  });

  it('addPageNode creates node and returns it', async () => {
    const { getBrainAccessor } = await import('../brain-accessor.js');
    const { closeBrainDb } = await import('../brain-sqlite.js');
    closeBrainDb();

    const accessor = await getBrainAccessor();
    const node = await accessor.addPageNode({
      id: 'task:T5241',
      nodeType: 'task',
      label: 'BRAIN/NEXUS Cognitive Infrastructure',
      metadataJson: '{"priority":"critical"}',
    });

    expect(node.id).toBe('task:T5241');
    expect(node.nodeType).toBe('task');
    expect(node.label).toBe('BRAIN/NEXUS Cognitive Infrastructure');
    expect(node.metadataJson).toBe('{"priority":"critical"}');
    expect(node.createdAt).toBeTruthy();
    // New fields with defaults
    expect(node.qualityScore).toBe(0.5);
    expect(node.contentHash).toBeNull();
    expect(node.lastActivityAt).toBeTruthy();
  });

  it('getPageNode returns node by ID', async () => {
    const { getBrainAccessor } = await import('../brain-accessor.js');
    const { closeBrainDb } = await import('../brain-sqlite.js');
    closeBrainDb();

    const accessor = await getBrainAccessor();
    // 'doc' was removed from BRAIN_NODE_TYPES in T528; use 'concept' instead
    await accessor.addPageNode({
      id: 'concept:BRAIN-SPEC',
      nodeType: 'concept',
      label: 'CLEO BRAIN Specification',
    });

    const fetched = await accessor.getPageNode('concept:BRAIN-SPEC');
    expect(fetched).not.toBeNull();
    expect(fetched!.id).toBe('concept:BRAIN-SPEC');
    expect(fetched!.nodeType).toBe('concept');
    expect(fetched!.label).toBe('CLEO BRAIN Specification');
  });

  it('getPageNode returns null for non-existent ID', async () => {
    const { getBrainAccessor } = await import('../brain-accessor.js');
    const { closeBrainDb } = await import('../brain-sqlite.js');
    closeBrainDb();

    const accessor = await getBrainAccessor();
    const result = await accessor.getPageNode('nonexistent');
    expect(result).toBeNull();
  });

  it('findPageNodes filters by nodeType', async () => {
    const { getBrainAccessor } = await import('../brain-accessor.js');
    const { closeBrainDb } = await import('../brain-sqlite.js');
    closeBrainDb();

    const accessor = await getBrainAccessor();
    await accessor.addPageNode({ id: 'task:T1', nodeType: 'task', label: 'Task 1' });
    // 'doc' removed in T528; use 'concept'
    await accessor.addPageNode({ id: 'concept:D1', nodeType: 'concept', label: 'Concept 1' });
    await accessor.addPageNode({ id: 'task:T2', nodeType: 'task', label: 'Task 2' });
    await accessor.addPageNode({ id: 'file:F1', nodeType: 'file', label: 'File 1' });

    const tasks = await accessor.findPageNodes({ nodeType: 'task' });
    expect(tasks).toHaveLength(2);
    expect(tasks.every((n) => n.nodeType === 'task')).toBe(true);

    const concepts = await accessor.findPageNodes({ nodeType: 'concept' });
    expect(concepts).toHaveLength(1);
    expect(concepts[0]!.id).toBe('concept:D1');

    const all = await accessor.findPageNodes();
    expect(all).toHaveLength(4);
  });

  it('findPageNodes filters by minQualityScore', async () => {
    const { getBrainAccessor } = await import('../brain-accessor.js');
    const { closeBrainDb } = await import('../brain-sqlite.js');
    closeBrainDb();

    const accessor = await getBrainAccessor();
    await accessor.addPageNode({
      id: 'decision:D1',
      nodeType: 'decision',
      label: 'High quality',
      qualityScore: 0.9,
    });
    await accessor.addPageNode({
      id: 'decision:D2',
      nodeType: 'decision',
      label: 'Low quality',
      qualityScore: 0.1,
    });
    await accessor.addPageNode({
      id: 'decision:D3',
      nodeType: 'decision',
      label: 'Medium quality',
      qualityScore: 0.5,
    });

    const highQuality = await accessor.findPageNodes({ minQualityScore: 0.8 });
    expect(highQuality).toHaveLength(1);
    expect(highQuality[0]!.id).toBe('decision:D1');

    const mediumAndAbove = await accessor.findPageNodes({ minQualityScore: 0.5 });
    expect(mediumAndAbove).toHaveLength(2);
  });

  it('addPageEdge creates edge and returns it', async () => {
    const { getBrainAccessor } = await import('../brain-accessor.js');
    const { closeBrainDb } = await import('../brain-sqlite.js');
    closeBrainDb();

    const accessor = await getBrainAccessor();
    await accessor.addPageNode({ id: 'task:T1', nodeType: 'task', label: 'Task 1' });
    await accessor.addPageNode({ id: 'task:T2', nodeType: 'task', label: 'Task 2' });

    // 'depends_on' removed in T528; use 'derived_from'
    const edge = await accessor.addPageEdge({
      fromId: 'task:T1',
      toId: 'task:T2',
      edgeType: 'derived_from',
      weight: 0.8,
    });

    expect(edge.fromId).toBe('task:T1');
    expect(edge.toId).toBe('task:T2');
    expect(edge.edgeType).toBe('derived_from');
    expect(edge.weight).toBe(0.8);
    expect(edge.createdAt).toBeTruthy();
  });

  it('addPageEdge supports provenance field', async () => {
    const { getBrainAccessor } = await import('../brain-accessor.js');
    const { closeBrainDb } = await import('../brain-sqlite.js');
    closeBrainDb();

    const accessor = await getBrainAccessor();
    await accessor.addPageNode({ id: 'observation:O1', nodeType: 'observation', label: 'Obs 1' });
    await accessor.addPageNode({ id: 'decision:D1', nodeType: 'decision', label: 'Decision 1' });

    const edge = await accessor.addPageEdge({
      fromId: 'observation:O1',
      toId: 'decision:D1',
      edgeType: 'supports',
      provenance: 'auto:task-complete',
    });

    expect(edge.provenance).toBe('auto:task-complete');
    expect(edge.weight).toBe(1.0);
  });

  it('getPageEdges returns in/out/both edges', async () => {
    const { getBrainAccessor } = await import('../brain-accessor.js');
    const { closeBrainDb } = await import('../brain-sqlite.js');
    closeBrainDb();

    const accessor = await getBrainAccessor();
    await accessor.addPageNode({ id: 'A', nodeType: 'task', label: 'A' });
    await accessor.addPageNode({ id: 'B', nodeType: 'task', label: 'B' });
    // 'concept' replaces 'doc'
    await accessor.addPageNode({ id: 'C', nodeType: 'concept', label: 'C' });

    // 'depends_on' → 'derived_from'; 'documents' is still valid
    await accessor.addPageEdge({ fromId: 'A', toId: 'B', edgeType: 'derived_from' });
    await accessor.addPageEdge({ fromId: 'C', toId: 'A', edgeType: 'documents' });

    const outEdges = await accessor.getPageEdges('A', 'out');
    expect(outEdges).toHaveLength(1);
    expect(outEdges[0]!.toId).toBe('B');

    const inEdges = await accessor.getPageEdges('A', 'in');
    expect(inEdges).toHaveLength(1);
    expect(inEdges[0]!.fromId).toBe('C');

    const bothEdges = await accessor.getPageEdges('A', 'both');
    expect(bothEdges).toHaveLength(2);
  });

  it('getNeighbors returns connected nodes', async () => {
    const { getBrainAccessor } = await import('../brain-accessor.js');
    const { closeBrainDb } = await import('../brain-sqlite.js');
    closeBrainDb();

    const accessor = await getBrainAccessor();
    await accessor.addPageNode({ id: 'A', nodeType: 'task', label: 'A' });
    await accessor.addPageNode({ id: 'B', nodeType: 'task', label: 'B' });
    // 'concept' replaces 'doc'
    await accessor.addPageNode({ id: 'C', nodeType: 'concept', label: 'C' });

    // 'depends_on' → 'derived_from'; 'documents' is still valid
    await accessor.addPageEdge({ fromId: 'A', toId: 'B', edgeType: 'derived_from' });
    await accessor.addPageEdge({ fromId: 'A', toId: 'C', edgeType: 'documents' });

    const allNeighbors = await accessor.getNeighbors('A');
    expect(allNeighbors).toHaveLength(2);

    const depNeighbors = await accessor.getNeighbors('A', 'derived_from');
    expect(depNeighbors).toHaveLength(1);
    expect(depNeighbors[0]!.id).toBe('B');
  });

  it('removePageNode cascades to remove edges', async () => {
    const { getBrainAccessor } = await import('../brain-accessor.js');
    const { closeBrainDb } = await import('../brain-sqlite.js');
    closeBrainDb();

    const accessor = await getBrainAccessor();
    await accessor.addPageNode({ id: 'A', nodeType: 'task', label: 'A' });
    await accessor.addPageNode({ id: 'B', nodeType: 'task', label: 'B' });
    // 'concept' replaces 'doc'
    await accessor.addPageNode({ id: 'C', nodeType: 'concept', label: 'C' });

    // 'depends_on' → 'derived_from'; 'documents' is still valid
    await accessor.addPageEdge({ fromId: 'A', toId: 'B', edgeType: 'derived_from' });
    await accessor.addPageEdge({ fromId: 'C', toId: 'A', edgeType: 'documents' });

    await accessor.removePageNode('A');

    const node = await accessor.getPageNode('A');
    expect(node).toBeNull();

    const edgesFromA = await accessor.getPageEdges('A', 'both');
    expect(edgesFromA).toHaveLength(0);

    const edgesToA = await accessor.getPageEdges('A', 'in');
    expect(edgesToA).toHaveLength(0);

    const nodeB = await accessor.getPageNode('B');
    expect(nodeB).not.toBeNull();
  });

  it('removePageEdge removes specific edge', async () => {
    const { getBrainAccessor } = await import('../brain-accessor.js');
    const { closeBrainDb } = await import('../brain-sqlite.js');
    closeBrainDb();

    const accessor = await getBrainAccessor();
    await accessor.addPageNode({ id: 'A', nodeType: 'task', label: 'A' });
    await accessor.addPageNode({ id: 'B', nodeType: 'task', label: 'B' });

    // 'depends_on' → 'derived_from'; 'relates_to' → 'informed_by'
    await accessor.addPageEdge({ fromId: 'A', toId: 'B', edgeType: 'derived_from' });
    await accessor.addPageEdge({ fromId: 'A', toId: 'B', edgeType: 'informed_by' });

    let edges = await accessor.getPageEdges('A', 'out');
    expect(edges).toHaveLength(2);

    await accessor.removePageEdge('A', 'B', 'derived_from');

    edges = await accessor.getPageEdges('A', 'out');
    expect(edges).toHaveLength(1);
    expect(edges[0]!.edgeType).toBe('informed_by');
  });
});
