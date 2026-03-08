/**
 * Tests for PageIndex graph tables (brain_page_nodes, brain_page_edges) in brain.db.
 *
 * Verifies table creation, CRUD operations, and composite primary key
 * constraint on edges.
 *
 * @epic T5149
 * @task T5160
 */

import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

let tempDir: string;
let cleoDir: string;

describe('brain.db PageIndex graph tables', () => {
  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'cleo-brain-pageindex-'));
    cleoDir = join(tempDir, '.cleo');
    process.env['CLEO_DIR'] = cleoDir;
  });

  afterEach(async () => {
    const { closeBrainDb } = await import('../brain-sqlite.js');
    closeBrainDb();
    delete process.env['CLEO_DIR'];
    await rm(tempDir, { recursive: true, force: true });
  });

  it('creates brain_page_nodes and brain_page_edges tables', async () => {
    const {
      getBrainDb,
      getBrainNativeDb,
      closeBrainDb: close,
    } = await import('../brain-sqlite.js');
    close();

    await getBrainDb();
    const nativeDb = getBrainNativeDb();
    expect(nativeDb).toBeTruthy();

    const tables = nativeDb!
      .prepare(
        "SELECT name FROM sqlite_master WHERE type='table' AND name LIKE 'brain_page_%' ORDER BY name",
      )
      .all() as Array<{ name: string }>;

    const names = tables.map((t) => t.name);
    expect(names).toContain('brain_page_nodes');
    expect(names).toContain('brain_page_edges');
  });

  it('creates expected PageIndex indexes', async () => {
    const {
      getBrainDb,
      getBrainNativeDb,
      closeBrainDb: close,
    } = await import('../brain-sqlite.js');
    close();

    await getBrainDb();
    const nativeDb = getBrainNativeDb();
    expect(nativeDb).toBeTruthy();

    const indexes = nativeDb!
      .prepare(
        "SELECT name FROM sqlite_master WHERE type='index' AND name LIKE 'idx_brain_%' ORDER BY name",
      )
      .all() as Array<{ name: string }>;

    const indexNames = indexes.map((i) => i.name);
    expect(indexNames).toContain('idx_brain_nodes_type');
    expect(indexNames).toContain('idx_brain_edges_from');
    expect(indexNames).toContain('idx_brain_edges_to');
  });

  it('inserts and queries page nodes', async () => {
    const {
      getBrainDb,
      getBrainNativeDb,
      closeBrainDb: close,
    } = await import('../brain-sqlite.js');
    close();

    await getBrainDb();
    const nativeDb = getBrainNativeDb();
    expect(nativeDb).toBeTruthy();

    nativeDb!
      .prepare(
        'INSERT INTO brain_page_nodes (id, node_type, label, metadata_json) VALUES (?, ?, ?, ?)',
      )
      .run('task:T5241', 'task', 'BRAIN/NEXUS Cognitive Infrastructure', '{"priority":"critical"}');

    nativeDb!
      .prepare('INSERT INTO brain_page_nodes (id, node_type, label) VALUES (?, ?, ?)')
      .run('doc:BRAIN-SPEC', 'doc', 'CLEO BRAIN Specification');

    const nodes = nativeDb!.prepare('SELECT * FROM brain_page_nodes ORDER BY id').all() as Array<{
      id: string;
      node_type: string;
      label: string;
      metadata_json: string | null;
    }>;

    expect(nodes).toHaveLength(2);
    expect(nodes[0]!.id).toBe('doc:BRAIN-SPEC');
    expect(nodes[0]!.node_type).toBe('doc');
    expect(nodes[1]!.id).toBe('task:T5241');
    expect(nodes[1]!.metadata_json).toBe('{"priority":"critical"}');
  });

  it('inserts and queries page edges', async () => {
    const {
      getBrainDb,
      getBrainNativeDb,
      closeBrainDb: close,
    } = await import('../brain-sqlite.js');
    close();

    await getBrainDb();
    const nativeDb = getBrainNativeDb();
    expect(nativeDb).toBeTruthy();

    // Insert nodes first
    nativeDb!
      .prepare('INSERT INTO brain_page_nodes (id, node_type, label) VALUES (?, ?, ?)')
      .run('task:T5157', 'task', 'sqlite-vec integration');
    nativeDb!
      .prepare('INSERT INTO brain_page_nodes (id, node_type, label) VALUES (?, ?, ?)')
      .run('task:T5149', 'task', 'BRAIN epic');

    // Insert edge
    nativeDb!
      .prepare(
        'INSERT INTO brain_page_edges (from_id, to_id, edge_type, weight) VALUES (?, ?, ?, ?)',
      )
      .run('task:T5157', 'task:T5149', 'depends_on', 1.0);

    const edges = nativeDb!
      .prepare('SELECT * FROM brain_page_edges WHERE from_id = ?')
      .all('task:T5157') as Array<{
      from_id: string;
      to_id: string;
      edge_type: string;
      weight: number;
    }>;

    expect(edges).toHaveLength(1);
    expect(edges[0]!.to_id).toBe('task:T5149');
    expect(edges[0]!.edge_type).toBe('depends_on');
    expect(edges[0]!.weight).toBe(1.0);
  });

  it('enforces composite primary key on edges', async () => {
    const {
      getBrainDb,
      getBrainNativeDb,
      closeBrainDb: close,
    } = await import('../brain-sqlite.js');
    close();

    await getBrainDb();
    const nativeDb = getBrainNativeDb();
    expect(nativeDb).toBeTruthy();

    // Insert first edge
    nativeDb!
      .prepare('INSERT INTO brain_page_edges (from_id, to_id, edge_type) VALUES (?, ?, ?)')
      .run('A', 'B', 'relates_to');

    // Same composite key should fail
    expect(() => {
      nativeDb!
        .prepare('INSERT INTO brain_page_edges (from_id, to_id, edge_type) VALUES (?, ?, ?)')
        .run('A', 'B', 'relates_to');
    }).toThrow();

    // Different edge_type should succeed (different composite key)
    expect(() => {
      nativeDb!
        .prepare('INSERT INTO brain_page_edges (from_id, to_id, edge_type) VALUES (?, ?, ?)')
        .run('A', 'B', 'documents');
    }).not.toThrow();
  });

  it('default weight is 1.0 when not specified', async () => {
    const {
      getBrainDb,
      getBrainNativeDb,
      closeBrainDb: close,
    } = await import('../brain-sqlite.js');
    close();

    await getBrainDb();
    const nativeDb = getBrainNativeDb();
    expect(nativeDb).toBeTruthy();

    nativeDb!
      .prepare('INSERT INTO brain_page_edges (from_id, to_id, edge_type) VALUES (?, ?, ?)')
      .run('X', 'Y', 'implements');

    const edge = nativeDb!
      .prepare('SELECT weight FROM brain_page_edges WHERE from_id = ? AND to_id = ?')
      .get('X', 'Y') as { weight: number };

    expect(edge.weight).toBe(1.0);
  });
});
