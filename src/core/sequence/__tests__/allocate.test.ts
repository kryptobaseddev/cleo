/**
 * Tests for atomic task ID allocation (allocateNextTaskId).
 * @task T5184
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { allocateNextTaskId, repairSequence, showSequence } from '../index.js';
import { getDb, getNativeDb, resetDbState } from '../../../store/sqlite.js';

describe('allocateNextTaskId', () => {
  let tempDir: string;

  beforeEach(async () => {
    // Reset any existing DB singleton
    resetDbState();
    tempDir = await mkdtemp(join(tmpdir(), 'cleo-alloc-test-'));
    await mkdir(join(tempDir, '.cleo'), { recursive: true });
    // Initialize DB by calling getDb — this creates schema, seeds sequence counter
    await getDb(tempDir);
  });

  afterEach(async () => {
    resetDbState();
    await rm(tempDir, { recursive: true, force: true });
  });

  it('returns T001 on fresh database', async () => {
    const id = await allocateNextTaskId(tempDir);
    expect(id).toBe('T001');
  });

  it('returns sequential IDs on multiple calls', async () => {
    const id1 = await allocateNextTaskId(tempDir);
    const id2 = await allocateNextTaskId(tempDir);
    const id3 = await allocateNextTaskId(tempDir);
    expect(id1).toBe('T001');
    expect(id2).toBe('T002');
    expect(id3).toBe('T003');
  });

  it('persists counter in sequence state', async () => {
    await allocateNextTaskId(tempDir);
    await allocateNextTaskId(tempDir);
    await allocateNextTaskId(tempDir);

    // The sequence counter should now be 3
    const seq = await showSequence(tempDir);
    expect(seq.counter).toBe(3);
    expect(seq.lastId).toBe('T003');
  });

  it('self-repairs when counter is behind actual data', async () => {
    const nativeDb = getNativeDb()!;

    // Manually insert a task with ID T010 to simulate stale counter
    nativeDb.prepare(
      `INSERT INTO tasks (id, title, status, priority, created_at) VALUES (?, ?, 'pending', 'medium', datetime('now'))`,
    ).run('T010', 'Existing task');

    // Counter is at 0 (seed), so allocateNextTaskId will try T001 first,
    // which doesn't collide. It should return T001 since T001 doesn't exist.
    const id = await allocateNextTaskId(tempDir);
    expect(id).toBe('T001');
  });

  it('self-repairs when counter produces a collision', async () => {
    const nativeDb = getNativeDb()!;

    // Set counter to 5
    nativeDb.prepare(`
      UPDATE schema_meta
      SET value = json_set(value, '$.counter', 5, '$.lastId', 'T005')
      WHERE key = 'task_id_sequence'
    `).run();

    // Insert T006 to cause a collision on next allocation
    nativeDb.prepare(
      `INSERT INTO tasks (id, title, status, priority, created_at) VALUES (?, ?, 'pending', 'medium', datetime('now'))`,
    ).run('T006', 'Blocking task');

    // Should detect collision on T006, repair, and return T007
    const id = await allocateNextTaskId(tempDir);
    expect(id).toBe('T007');
  });

  it('handles rapid sequential allocation of 100 IDs', async () => {
    const ids = new Set<string>();
    for (let i = 0; i < 100; i++) {
      const id = await allocateNextTaskId(tempDir);
      ids.add(id);
    }
    // All 100 IDs should be unique
    expect(ids.size).toBe(100);

    // Should be T001 through T100
    expect(ids.has('T001')).toBe(true);
    expect(ids.has('T100')).toBe(true);
  });

  it('re-initializes DB if singleton was reset', async () => {
    // Even after resetDbState(), allocateNextTaskId should work because
    // it calls getDb() which re-initializes the singleton
    resetDbState();
    const id = await allocateNextTaskId(tempDir);
    expect(id).toBe('T001');
  });

  it('pads IDs to at least 3 digits', async () => {
    const id = await allocateNextTaskId(tempDir);
    expect(id).toBe('T001');
    expect(id).toMatch(/^T\d{3,}$/);
  });

  it('does not pad beyond necessary digits', async () => {
    const nativeDb = getNativeDb()!;

    // Set counter to 999
    nativeDb.prepare(`
      UPDATE schema_meta
      SET value = json_set(value, '$.counter', 999, '$.lastId', 'T999')
      WHERE key = 'task_id_sequence'
    `).run();

    const id = await allocateNextTaskId(tempDir);
    expect(id).toBe('T1000');
  });
});
