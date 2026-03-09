/**
 * Sticky Domain E2E Tests
 *
 * End-to-end tests for the sticky domain handler:
 * 1. Add a sticky note
 * 2. List sticky notes
 * 3. Show a sticky note
 * 4. Archive a sticky note
 * 5. Purge a sticky note
 * 6. Convert a sticky note to a task
 *
 * All tests use real brain.db in temp directories. No mocks.
 */

import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

describe('Sticky domain E2E workflow', () => {
  let testDir: string;
  let cleoDir: string;

  beforeEach(async () => {
    testDir = await mkdtemp(join(tmpdir(), 'sticky-e2e-'));
    cleoDir = join(testDir, '.cleo');
    await mkdir(cleoDir, { recursive: true });
    process.env['CLEO_DIR'] = cleoDir;
    process.env['CLEO_ROOT'] = testDir;

    // Reset brain.db singleton so it picks up the new CLEO_DIR
    const { resetBrainDbState } = await import('../../src/store/brain-sqlite.js');
    resetBrainDbState();

    // Reset tasks.db singleton for convert-to-task
    const { closeDb } = await import('../../src/store/sqlite.js');
    closeDb();
  });

  afterEach(async () => {
    const { closeAllDatabases } = await import('../../src/store/sqlite.js');
    await closeAllDatabases();
    delete process.env['CLEO_DIR'];
    delete process.env['CLEO_ROOT'];
    await rm(testDir, { recursive: true, force: true });
  });

  it('should add a sticky note via stickyAdd engine', async () => {
    const { stickyAdd } = await import('../../src/dispatch/engines/sticky-engine.js');

    const result = await stickyAdd(testDir, {
      content: 'Remember to fix the migration issue',
      tags: ['bug', 'migration'],
      color: 'red',
      priority: 'high',
    });

    expect(result.success).toBe(true);
    expect(result.data).toBeDefined();
    expect(result.data!.content).toBe('Remember to fix the migration issue');
    expect(result.data!.tags).toEqual(['bug', 'migration']);
    expect(result.data!.color).toBe('red');
    expect(result.data!.priority).toBe('high');
    expect(result.data!.status).toBe('active');
    expect(result.data!.id).toBeTruthy();
  });

  it('should list sticky notes after adding multiple', async () => {
    const { stickyAdd, stickyList } = await import('../../src/dispatch/engines/sticky-engine.js');

    await stickyAdd(testDir, { content: 'Sticky one', color: 'yellow' });
    await stickyAdd(testDir, { content: 'Sticky two', color: 'blue' });
    await stickyAdd(testDir, { content: 'Sticky three', color: 'yellow' });

    const result = await stickyList(testDir, {});
    expect(result.success).toBe(true);
    expect(result.data!.stickies.length).toBe(3);
    expect(result.data!.total).toBe(3);
  });

  it('should show a specific sticky note by ID', async () => {
    const { stickyAdd, stickyShow } = await import('../../src/dispatch/engines/sticky-engine.js');

    const addResult = await stickyAdd(testDir, { content: 'Find me by ID' });
    expect(addResult.success).toBe(true);
    const stickyId = addResult.data!.id;

    const showResult = await stickyShow(testDir, stickyId);
    expect(showResult.success).toBe(true);
    expect(showResult.data).toBeDefined();
    expect(showResult.data!.content).toBe('Find me by ID');
    expect(showResult.data!.id).toBe(stickyId);
  });

  it('should archive a sticky note', async () => {
    const { stickyAdd, stickyArchive, stickyShow } = await import(
      '../../src/dispatch/engines/sticky-engine.js'
    );

    const addResult = await stickyAdd(testDir, { content: 'Archive me' });
    const stickyId = addResult.data!.id;

    const archiveResult = await stickyArchive(testDir, stickyId);
    expect(archiveResult.success).toBe(true);

    // Verify status changed to archived
    const showResult = await stickyShow(testDir, stickyId);
    expect(showResult.success).toBe(true);
    expect(showResult.data!.status).toBe('archived');
  });

  it('should purge a sticky note', async () => {
    const { stickyAdd, stickyPurge, stickyShow } = await import(
      '../../src/dispatch/engines/sticky-engine.js'
    );

    const addResult = await stickyAdd(testDir, { content: 'Purge me' });
    const stickyId = addResult.data!.id;

    const purgeResult = await stickyPurge(testDir, stickyId);
    expect(purgeResult.success).toBe(true);

    // Verify sticky is gone
    const showResult = await stickyShow(testDir, stickyId);
    // After purge the note should not be found or return null
    if (showResult.success) {
      expect(showResult.data).toBeNull();
    } else {
      expect(showResult.success).toBe(false);
    }
  });

  it('should convert a sticky note to a task', async () => {
    const { stickyAdd, stickyConvertToTask, stickyShow } = await import(
      '../../src/dispatch/engines/sticky-engine.js'
    );

    // Initialize tasks.db so convert-to-task can create the task
    const { getDb } = await import('../../src/store/sqlite.js');
    await getDb();

    const addResult = await stickyAdd(testDir, { content: 'Convert me to a task' });
    const stickyId = addResult.data!.id;

    const convertResult = await stickyConvertToTask(testDir, stickyId, 'My new task');
    expect(convertResult.success).toBe(true);

    // Verify sticky status changed to converted
    const showResult = await stickyShow(testDir, stickyId);
    expect(showResult.success).toBe(true);
    expect(showResult.data!.status).toBe('converted');
  });

  it('full lifecycle: add -> list -> show -> archive -> purge', async () => {
    const { stickyAdd, stickyArchive, stickyList, stickyPurge, stickyShow } = await import(
      '../../src/dispatch/engines/sticky-engine.js'
    );

    // Add
    const s1 = await stickyAdd(testDir, { content: 'Lifecycle test', priority: 'medium' });
    expect(s1.success).toBe(true);
    const id = s1.data!.id;

    // List
    const list1 = await stickyList(testDir, {});
    expect(list1.data!.stickies.length).toBe(1);

    // Show
    const show = await stickyShow(testDir, id);
    expect(show.data!.content).toBe('Lifecycle test');

    // Archive
    const arch = await stickyArchive(testDir, id);
    expect(arch.success).toBe(true);

    // Active list should be empty
    const list2 = await stickyList(testDir, { status: 'active' });
    expect(list2.data!.stickies.length).toBe(0);

    // Purge
    const purge = await stickyPurge(testDir, id);
    expect(purge.success).toBe(true);

    // Total list should be empty after purge
    const list3 = await stickyList(testDir, {});
    expect(list3.data!.stickies.length).toBe(0);
  });
});
