/**
 * Tests for PageIndex accessor methods on BrainDataAccessor.
 *
 * Validates addPageNode, getPageNode, findPageNodes, removePageNode,
 * addPageEdge, getPageEdges, getNeighbors, and removePageEdge using
 * in-memory brain.db instances.
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
  });

  it('getPageNode returns node by ID', async () => {
    const { getBrainAccessor } = await import('../brain-accessor.js');
    const { closeBrainDb } = await import('../brain-sqlite.js');
    closeBrainDb();

    const accessor = await getBrainAccessor();
    await accessor.addPageNode({
      id: 'doc:BRAIN-SPEC',
      nodeType: 'doc',
      label: 'CLEO BRAIN Specification',
    });

    const fetched = await accessor.getPageNode('doc:BRAIN-SPEC');
    expect(fetched).not.toBeNull();
    expect(fetched!.id).toBe('doc:BRAIN-SPEC');
    expect(fetched!.nodeType).toBe('doc');
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
    await accessor.addPageNode({ id: 'doc:D1', nodeType: 'doc', label: 'Doc 1' });
    await accessor.addPageNode({ id: 'task:T2', nodeType: 'task', label: 'Task 2' });
    await accessor.addPageNode({ id: 'file:F1', nodeType: 'file', label: 'File 1' });

    const tasks = await accessor.findPageNodes({ nodeType: 'task' });
    expect(tasks).toHaveLength(2);
    expect(tasks.every((n) => n.nodeType === 'task')).toBe(true);

    const docs = await accessor.findPageNodes({ nodeType: 'doc' });
    expect(docs).toHaveLength(1);
    expect(docs[0]!.id).toBe('doc:D1');

    const all = await accessor.findPageNodes();
    expect(all).toHaveLength(4);
  });

  it('addPageEdge creates edge and returns it', async () => {
    const { getBrainAccessor } = await import('../brain-accessor.js');
    const { closeBrainDb } = await import('../brain-sqlite.js');
    closeBrainDb();

    const accessor = await getBrainAccessor();
    await accessor.addPageNode({ id: 'task:T1', nodeType: 'task', label: 'Task 1' });
    await accessor.addPageNode({ id: 'task:T2', nodeType: 'task', label: 'Task 2' });

    const edge = await accessor.addPageEdge({
      fromId: 'task:T1',
      toId: 'task:T2',
      edgeType: 'depends_on',
      weight: 0.8,
    });

    expect(edge.fromId).toBe('task:T1');
    expect(edge.toId).toBe('task:T2');
    expect(edge.edgeType).toBe('depends_on');
    expect(edge.weight).toBe(0.8);
    expect(edge.createdAt).toBeTruthy();
  });

  it('getPageEdges returns in/out/both edges', async () => {
    const { getBrainAccessor } = await import('../brain-accessor.js');
    const { closeBrainDb } = await import('../brain-sqlite.js');
    closeBrainDb();

    const accessor = await getBrainAccessor();
    await accessor.addPageNode({ id: 'A', nodeType: 'task', label: 'A' });
    await accessor.addPageNode({ id: 'B', nodeType: 'task', label: 'B' });
    await accessor.addPageNode({ id: 'C', nodeType: 'doc', label: 'C' });

    await accessor.addPageEdge({ fromId: 'A', toId: 'B', edgeType: 'depends_on' });
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
    await accessor.addPageNode({ id: 'C', nodeType: 'doc', label: 'C' });

    await accessor.addPageEdge({ fromId: 'A', toId: 'B', edgeType: 'depends_on' });
    await accessor.addPageEdge({ fromId: 'A', toId: 'C', edgeType: 'documents' });

    const allNeighbors = await accessor.getNeighbors('A');
    expect(allNeighbors).toHaveLength(2);

    const depNeighbors = await accessor.getNeighbors('A', 'depends_on');
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
    await accessor.addPageNode({ id: 'C', nodeType: 'doc', label: 'C' });

    await accessor.addPageEdge({ fromId: 'A', toId: 'B', edgeType: 'depends_on' });
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

    await accessor.addPageEdge({ fromId: 'A', toId: 'B', edgeType: 'depends_on' });
    await accessor.addPageEdge({ fromId: 'A', toId: 'B', edgeType: 'relates_to' });

    let edges = await accessor.getPageEdges('A', 'out');
    expect(edges).toHaveLength(2);

    await accessor.removePageEdge('A', 'B', 'depends_on');

    edges = await accessor.getPageEdges('A', 'out');
    expect(edges).toHaveLength(1);
    expect(edges[0]!.edgeType).toBe('relates_to');
  });
});
