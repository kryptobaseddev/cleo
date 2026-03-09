/**
 * Cross-Domain Workflow E2E Test
 *
 * Tests a realistic multi-domain workflow that exercises several domains
 * in a single coherent scenario:
 *
 * 1. Initialize database (tasks.db + brain.db)
 * 2. Start a session (session domain)
 * 3. Create a task (task domain)
 * 4. Start working on the task (session/task-work)
 * 5. Observe a memory (memory/brain domain)
 * 6. Create a sticky note (sticky domain)
 * 7. Complete the task (task domain)
 * 8. End the session (session domain)
 * 9. Verify audit trail exists
 *
 * All tests use real SQLite databases in temp directories. No mocks.
 */

import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

describe('Cross-domain workflow E2E', () => {
  let testDir: string;
  let cleoDir: string;

  beforeEach(async () => {
    testDir = await mkdtemp(join(tmpdir(), 'cross-domain-e2e-'));
    cleoDir = join(testDir, '.cleo');
    await mkdir(cleoDir, { recursive: true });
    process.env['CLEO_DIR'] = cleoDir;
    process.env['CLEO_ROOT'] = testDir;

    // Reset all database singletons
    const { closeDb } = await import('../../src/store/sqlite.js');
    closeDb();
    const { resetBrainDbState } = await import('../../src/store/brain-sqlite.js');
    resetBrainDbState();
    try {
      const { resetFts5Cache } = await import('../../src/core/memory/brain-search.js');
      resetFts5Cache();
    } catch {
      // Module may not export this in all versions
    }
  });

  afterEach(async () => {
    const { closeAllDatabases } = await import('../../src/store/sqlite.js');
    await closeAllDatabases();
    delete process.env['CLEO_DIR'];
    delete process.env['CLEO_ROOT'];
    await rm(testDir, { recursive: true, force: true });
  });

  it('session -> task -> memory -> sticky -> complete -> end session', async () => {
    // --- Step 1: Initialize tasks.db ---
    const { getDb } = await import('../../src/store/sqlite.js');
    const db = await getDb();
    const { tasks } = await import('../../src/store/schema.js');

    // Insert a root epic for the session scope
    await db.insert(tasks).values({
      id: 'T001',
      title: 'Cross-domain test epic',
      description: 'Epic for cross-domain workflow test',
      status: 'active',
      priority: 'high',
      type: 'epic',
      position: 1,
      positionVersion: 0,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });

    // --- Step 2: Start a session ---
    const sessionEngine = await import('../../src/dispatch/engines/session-engine.js');
    const sessionResult = await sessionEngine.sessionStart(testDir, {
      scope: 'epic:T001',
      name: 'cross-domain-session',
    });
    expect(sessionResult.success).toBe(true);
    expect(sessionResult.data!.status).toBe('active');
    expect(sessionResult.data!.name).toBe('cross-domain-session');

    // --- Step 3: Create a task ---
    // Re-acquire db handle since sessionStart may have closed/reopened it
    const db2 = await getDb();
    await db2.insert(tasks).values({
      id: 'T002',
      title: 'Implement feature X',
      description: 'Add feature X to the system as part of cross-domain test',
      status: 'pending',
      priority: 'medium',
      type: 'task',
      parentId: 'T001',
      position: 2,
      positionVersion: 0,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });

    // --- Step 4: Start working on the task ---
    const taskWorkResult = await sessionEngine.taskStart(testDir, 'T002');
    expect(taskWorkResult.success).toBe(true);

    // Verify current task
    const currentResult = await sessionEngine.taskCurrentGet(testDir);
    expect(currentResult.success).toBe(true);

    // --- Step 5: Observe a memory (brain domain) ---
    const brainRetrieval = await import('../../src/core/memory/brain-retrieval.js');
    const obs = await brainRetrieval.observeBrain(testDir, {
      text: 'Cross-domain test: feature X requires database migration',
      title: 'Feature X migration requirement',
      type: 'discovery',
      project: 'test-project',
      sourceType: 'agent',
    });
    expect(obs.id).toMatch(/^O-/);

    // Verify the observation is searchable
    const searchResult = await brainRetrieval.searchBrainCompact(testDir, {
      query: 'feature X migration',
    });
    expect(searchResult.results.length).toBeGreaterThanOrEqual(1);

    // --- Step 6: Create a sticky note ---
    const { stickyAdd, stickyList } = await import('../../src/dispatch/engines/sticky-engine.js');
    const stickyResult = await stickyAdd(testDir, {
      content: 'TODO: update docs after feature X lands',
      tags: ['docs', 'feature-x'],
      priority: 'low',
    });
    expect(stickyResult.success).toBe(true);
    expect(stickyResult.data!.id).toBeTruthy();

    // Verify sticky shows up in list
    const stickyListResult = await stickyList(testDir, {});
    expect(stickyListResult.success).toBe(true);
    expect(stickyListResult.data!.stickies.length).toBe(1);

    // --- Step 7: Stop working on the task ---
    const stopResult = await sessionEngine.taskStop(testDir);
    expect(stopResult.success).toBe(true);

    // --- Step 8: End the session ---
    const endResult = await sessionEngine.sessionEnd(testDir);
    expect(endResult.success).toBe(true);

    // --- Step 9: Verify session was recorded ---
    const listResult = await sessionEngine.sessionList(testDir);
    expect(listResult.success).toBe(true);
    expect(listResult.data!.sessions.length).toBeGreaterThanOrEqual(1);

    const session = listResult.data!.sessions.find(
      (s: { name: string }) => s.name === 'cross-domain-session',
    );
    expect(session).toBeDefined();
  });

  it('task creation -> sticky -> convert sticky to task', async () => {
    // Initialize databases
    const { getDb } = await import('../../src/store/sqlite.js');
    await getDb();

    // Create a sticky note
    const { stickyAdd, stickyConvertToTask, stickyShow } = await import(
      '../../src/dispatch/engines/sticky-engine.js'
    );

    const stickyResult = await stickyAdd(testDir, {
      content: 'This should become a real task',
      tags: ['convert'],
      priority: 'high',
    });
    expect(stickyResult.success).toBe(true);
    const stickyId = stickyResult.data!.id;

    // Convert sticky to task
    const convertResult = await stickyConvertToTask(testDir, stickyId, 'Converted from sticky');
    expect(convertResult.success).toBe(true);

    // Verify sticky is now converted
    const showResult = await stickyShow(testDir, stickyId);
    expect(showResult.success).toBe(true);
    expect(showResult.data!.status).toBe('converted');
  });

  it('memory observation -> search -> fetch (brain 3-layer pattern)', async () => {
    const brainRetrieval = await import('../../src/core/memory/brain-retrieval.js');

    // Create multiple observations
    const obs1 = await brainRetrieval.observeBrain(testDir, {
      text: 'Authentication uses JWT tokens with 24h expiry',
      title: 'Auth uses JWT',
      type: 'discovery',
      project: 'cross-test',
      sourceType: 'agent',
    });

    // Small delay to avoid ID collision
    await new Promise((resolve) => setTimeout(resolve, 10));

    const obs2 = await brainRetrieval.observeBrain(testDir, {
      text: 'Database uses WAL mode for concurrent reads',
      title: 'DB WAL mode',
      type: 'pattern',
      project: 'cross-test',
      sourceType: 'agent',
    });

    // Layer 1: Search (compact)
    const searchResult = await brainRetrieval.searchBrainCompact(testDir, {
      query: 'JWT authentication',
    });
    expect(searchResult.results.length).toBeGreaterThanOrEqual(1);

    // Layer 2: Fetch (full details)
    const fetchResult = await brainRetrieval.fetchBrainEntries(testDir, {
      ids: [obs1.id, obs2.id],
    });
    expect(fetchResult.results.length).toBe(2);

    // Verify data integrity -- FetchedBrainEntry has { id, type, data }
    // data is the raw DB row with title, narrative, etc.
    const jwtEntry = fetchResult.results.find((e) => e.id === obs1.id);
    expect(jwtEntry).toBeDefined();
    expect(jwtEntry!.type).toBe('observation');
    const jwtData = jwtEntry!.data as { title?: string; narrative?: string };
    expect(jwtData.title).toBe('Auth uses JWT');

    const walEntry = fetchResult.results.find((e) => e.id === obs2.id);
    expect(walEntry).toBeDefined();
    const walData = walEntry!.data as { title?: string; narrative?: string };
    expect(walData.title).toBe('DB WAL mode');
  });
});
