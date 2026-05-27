/**
 * Regression test: decision-store → memory-link → decision-find workflow.
 *
 * Proves that an agent can:
 * 1. Store a decision with task context via cleo memory decision-store
 * 2. Link the decision to a task via cleo memory link
 * 3. Find the decision via cleo memory decision-find (BRAIN FTS5, not file grep)
 * 4. Retrieve linked decisions via getLinkedDecisions
 *
 * All lookups use the BRAIN database — no filesystem grep needed.
 *
 * @task T11059
 * @epic T10520
 * @saga T10516
 */

import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { homedir } from 'node:os';

let tempDir: string;
let cleoDir: string;

/** Register a project in the CLEO nexus registry so resolveCanonicalCleoDir works. */
function registerInNexus(projectId: string, projectPath: string): void {
  const nexusPath = join(homedir(), '.cleo', 'nexus.db');
  const db = new DatabaseSync(nexusPath);
  db.exec('CREATE TABLE IF NOT EXISTS project_registry (project_id TEXT PRIMARY KEY, project_hash TEXT NOT NULL, project_path TEXT NOT NULL, name TEXT NOT NULL)');
  db.prepare(
    'INSERT OR REPLACE INTO project_registry (project_id, project_hash, project_path, name) VALUES (?, ?, ?, ?)',
  ).run(projectId, '000000000000', projectPath, 'test-decision-link');
  db.close();
}

/** Initialize a minimal tasks.db in the temp project with test task IDs. */
function initTasksDb(root: string): void {
  const dbPath = join(root, '.cleo', 'tasks.db');
  const db = new DatabaseSync(dbPath);
  db.exec('PRAGMA journal_mode=WAL');
  db.exec(`
    CREATE TABLE IF NOT EXISTS tasks (
      id TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      status TEXT DEFAULT 'pending',
      type TEXT,
      parent_id TEXT,
      position INTEGER DEFAULT 0
    );
    CREATE TABLE IF NOT EXISTS task_relations (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      from_id TEXT NOT NULL,
      to_id TEXT NOT NULL,
      relation_type TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS task_acceptance_criteria (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      task_id TEXT NOT NULL,
      criterion TEXT NOT NULL,
      position INTEGER DEFAULT 0
    );
  `);
  for (const id of ['T11059', 'T1000', 'T2000']) {
    db.prepare(
      'INSERT OR IGNORE INTO tasks (id, title, status, type, position) VALUES (?, ?, ?, ?, ?)',
    ).run(id, `Test task ${id}`, 'pending', 'task', 0);
  }
  db.close();
}

describe('Decision-store → memory-link → decision-find regression', () => {
  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'cleo-decision-link-regression-'));
    cleoDir = join(tempDir, '.cleo');
    await mkdir(cleoDir, { recursive: true });

    const projectId = 'test-decision-link-regression';

    // Create minimal project-info.json so resolveProjectByCwd succeeds.
    await writeFile(
      join(cleoDir, 'project-info.json'),
      JSON.stringify({
        projectId,
        projectHash: '000000000000',
        cleoVersion: '0.0.0',
        lastUpdated: new Date().toISOString(),
      }),
      'utf-8',
    );

    // Register in nexus so resolveCanonicalCleoDir works
    registerInNexus(projectId, tempDir);

    // Initialize tasks.db directly (bypassing getDb which requires nexus registry)
    initTasksDb(tempDir);
  });

  afterEach(async () => {
    const { closeBrainDb } = await import('../../store/memory-sqlite.js');
    const { resetDbState } = await import('../../store/sqlite.js');
    // Also reset brain state
    try {
      const { resetBrainDbState } = await import('../../store/memory-sqlite.js');
      resetBrainDbState();
    } catch {
      /* module may not be loaded */
    }
    closeBrainDb();
    resetDbState();
    await Promise.race([
      rm(tempDir, { recursive: true, force: true, maxRetries: 3, retryDelay: 300 }).catch(() => {}),
      new Promise<void>((resolve) => setTimeout(resolve, 8_000)),
    ]);
  });

  // =========================================================================
  // AC1: Store a decision with task context
  // =========================================================================

  describe('AC1: decision-store with task context', () => {
    it('stores a decision and returns a D-prefixed ID', async () => {
      const { memoryDecisionStore } = await import('../engine-compat.js');

      const result = await memoryDecisionStore(
        {
          decision: 'Use SQLite for durable brain storage',
          rationale: 'Embedded database with no network dependency, FTS5 support, and WAL mode',
          taskId: 'T11059',
        },
        tempDir,
      );

      // Debug: dump the full result on failure
      if (!result.success) {
        console.error('STORE FAILED:', JSON.stringify(result, null, 2));
      }

      expect(result.success).toBe(true);
      expect(result.data).toBeDefined();
      expect(result.data!.id).toMatch(/^D\d{3}$/);
      expect(result.data!.decision).toBe('Use SQLite for durable brain storage');
    });

    it('stores a decision with alternatives listed', async () => {
      const { memoryDecisionStore } = await import('../engine-compat.js');

      const result = await memoryDecisionStore(
        {
          decision: 'Adopt Vitest over Jest',
          rationale: 'Native ESM support, faster, better TypeScript integration',
          alternatives: ['Jest with ts-jest', 'Mocha with ts-node', 'Node test runner'],
          taskId: 'T1000',
        },
        tempDir,
      );

      expect(result.success).toBe(true);
      expect(result.data!.id).toMatch(/^D\d{3}$/);
    });

    it('rejects decision-store without decision text', async () => {
      const { memoryDecisionStore } = await import('../engine-compat.js');

      const result = await memoryDecisionStore(
        { decision: '', rationale: 'No decision text' },
        tempDir,
      );

      expect(result.success).toBe(false);
      expect(result.error!.code).toBe('E_INVALID_INPUT');
    });

    it('rejects decision-store without rationale', async () => {
      const { memoryDecisionStore } = await import('../engine-compat.js');

      const result = await memoryDecisionStore(
        { decision: 'Some decision', rationale: '' },
        tempDir,
      );

      expect(result.success).toBe(false);
      expect(result.error!.code).toBe('E_INVALID_INPUT');
    });
  });

  // =========================================================================
  // AC2: Link decision to task + find without file grep
  // =========================================================================

  describe('AC2: memory-link + decision-find (no file grep)', () => {
    it('links a decision to a task, then finds it via BRAIN FTS5 search', async () => {
      const { memoryDecisionStore, memoryLink, memoryDecisionFind } = await import(
        '../engine-compat.js'
      );

      // Step 1: Store a decision with task context
      const storeResult = await memoryDecisionStore(
        {
          decision: 'Route docs CLI through single dispatch surface',
          rationale:
            'Unified surface reduces agent cognitive overhead and ensures consistent output formats',
          taskId: 'T11059',
        },
        tempDir,
      );
      expect(storeResult.success).toBe(true);
      const decisionId = storeResult.data!.id;
      expect(decisionId).toMatch(/^D\d{3}$/);

      // Step 2: Link the decision to the task via the memory link pipeline
      const linkResult = await memoryLink(
        { taskId: 'T11059', entryId: decisionId },
        tempDir,
      );
      expect(linkResult.success).toBe(true);
      expect(linkResult.data!.linked).toBe(true);

      // Step 3: Find the decision via BRAIN search (NOT file grep)
      const findResult = await memoryDecisionFind(
        { query: 'dispatch surface' },
        tempDir,
      );
      expect(findResult.success).toBe(true);
      const decisions = findResult.data!.decisions as Array<Record<string, unknown>>;

      // The stored decision should appear in results
      const found = decisions.find((d) => d.id === decisionId);
      expect(found).toBeDefined();
      expect(found!.decision).toContain('Route docs CLI');

      // AC2 assertion: lookup returned the decision without relying on file grep.
      // This test purely exercises the BRAIN database pipeline — no filesystem access.
    });

    it('finds decisions by rationale text search', async () => {
      const { memoryDecisionStore, memoryDecisionFind } = await import('../engine-compat.js');

      await memoryDecisionStore(
        {
          decision: 'Prefer BRAIN decisions over ledger blobs',
          rationale:
            'BRAIN decisions are indexed, searchable, and linkable to tasks — unlike raw file blobs',
          taskId: 'T11059',
        },
        tempDir,
      );

      // Search by rationale content (not the decision title)
      const findResult = await memoryDecisionFind(
        { query: 'indexed, searchable' },
        tempDir,
      );
      expect(findResult.success).toBe(true);
      const decisions = findResult.data!.decisions as Array<Record<string, unknown>>;
      expect(decisions.length).toBeGreaterThanOrEqual(1);
    });

    it('finds decisions by taskId without query string', async () => {
      const { memoryDecisionStore, memoryDecisionFind } = await import('../engine-compat.js');

      await memoryDecisionStore(
        {
          decision: 'Use task-scoped memory linking',
          rationale: 'Each task links its own decisions for focused retrieval',
          taskId: 'T2000',
        },
        tempDir,
      );

      // Find by task context
      const findResult = await memoryDecisionFind(
        { taskId: 'T2000' },
        tempDir,
      );
      expect(findResult.success).toBe(true);
      const decisions = findResult.data!.decisions as Array<Record<string, unknown>>;
      expect(decisions.length).toBeGreaterThanOrEqual(1);

      const found = decisions.find(
        (d) => (d as Record<string, unknown>).contextTaskId === 'T2000',
      );
      expect(found).toBeDefined();
    });
  });

  // =========================================================================
  // AC3: End-to-end workflow gives enough info to cite the decision
  // =========================================================================

  describe('AC3: full workflow yields citable decision', () => {
    it('decision-find result includes all fields needed for citation', async () => {
      const { memoryDecisionStore, memoryLink, memoryDecisionFind } = await import(
        '../engine-compat.js'
      );

      // Store and link
      const storeResult = await memoryDecisionStore(
        {
          decision: 'Cache brain queries with LRU eviction',
          rationale:
            'Reduces repeated FTS5 scans; LRU policy keeps hot decisions in memory while bounding memory usage',
          taskId: 'T11059',
        },
        tempDir,
      );
      const decisionId = storeResult.data!.id;

      await memoryLink({ taskId: 'T11059', entryId: decisionId }, tempDir);

      // Find and inspect full result shape
      const findResult = await memoryDecisionFind(
        { query: 'LRU eviction' },
        tempDir,
      );
      expect(findResult.success).toBe(true);
      const decisions = findResult.data!.decisions as Array<Record<string, unknown>>;
      const found = decisions.find((d) => d.id === decisionId);
      expect(found).toBeDefined();

      // AC3: The result must include enough fields for an agent to cite the decision.
      // Verify the essential citation fields are present.
      expect(found!.id).toBeTruthy();
      expect(found!.decision).toBeTruthy();
      expect(found!.rationale).toBeTruthy();
      expect(found!.type).toBeTruthy();
      expect(found!.confidence).toBeTruthy();

      // Verify task context is preserved for citation provenance
      expect((found as Record<string, unknown>).contextTaskId).toBe('T11059');
    });

    it('linked decisions are retrievable via convenience API', async () => {
      const { memoryDecisionStore, memoryLink } = await import('../engine-compat.js');
      const { getLinkedDecisions } = await import('../brain-links.js');
      const { closeBrainDb } = await import('../../store/memory-sqlite.js');

      // Ensure clean state
      closeBrainDb();

      // Store two decisions and link both to T11059
      const d1 = await memoryDecisionStore(
        { decision: 'Decision A: Use durable storage', rationale: 'Must survive restarts', taskId: 'T11059' },
        tempDir,
      );
      const d2 = await memoryDecisionStore(
        { decision: 'Decision B: Use FTS5 for text search', rationale: 'Built into SQLite', taskId: 'T11059' },
        tempDir,
      );

      await memoryLink({ taskId: 'T11059', entryId: d1.data!.id }, tempDir);
      await memoryLink({ taskId: 'T11059', entryId: d2.data!.id }, tempDir);

      // Retrieve linked decisions
      const linked = await getLinkedDecisions(tempDir, 'T11059');
      expect(linked.length).toBeGreaterThanOrEqual(2);

      const linkedIds = linked.map((d) => d.id);
      expect(linkedIds).toContain(d1.data!.id);
      expect(linkedIds).toContain(d2.data!.id);

      // Each linked decision has full cite-able content
      for (const d of linked) {
        expect(d.id).toBeTruthy();
        expect(d.decision).toBeTruthy();
        expect(d.rationale).toBeTruthy();
      }
    });
  });

  // =========================================================================
  // Edge cases
  // =========================================================================

  describe('edge cases', () => {
    it('memoryLink rejects invalid entryId format', async () => {
      const { memoryLink } = await import('../engine-compat.js');

      const result = await memoryLink(
        { taskId: 'T11059', entryId: 'not-a-valid-prefix' },
        tempDir,
      );

      expect(result.success).toBe(false);
      expect(result.error!.code).toBe('E_INVALID_INPUT');
    });

    it('memoryDecisionFind returns empty for non-matching query', async () => {
      const { memoryDecisionFind } = await import('../engine-compat.js');

      const result = await memoryDecisionFind(
        { query: 'xyzzy-nonexistent-decision-query' },
        tempDir,
      );

      expect(result.success).toBe(true);
      const decisions = result.data!.decisions as Array<Record<string, unknown>>;
      expect(decisions).toHaveLength(0);
    });

    it('idempotent: linking same decision twice does not error', async () => {
      const { memoryDecisionStore, memoryLink } = await import('../engine-compat.js');

      const storeResult = await memoryDecisionStore(
        { decision: 'Idempotent link test', rationale: 'Testing duplicate link handling', taskId: 'T11059' },
        tempDir,
      );
      const decisionId = storeResult.data!.id;

      // Link twice — should not throw
      await memoryLink({ taskId: 'T11059', entryId: decisionId }, tempDir);
      const secondLink = await memoryLink(
        { taskId: 'T11059', entryId: decisionId },
        tempDir,
      );

      // Both should succeed (idempotent — existing link is returned)
      expect(secondLink.success).toBe(true);
    });
  });
});
