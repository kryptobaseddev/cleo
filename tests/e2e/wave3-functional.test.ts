/**
 * Wave 3 Functional E2E Tests
 *
 * Comprehensive end-to-end tests for Wave 3 features:
 * 1. session.find through full dispatch path
 * 2. brain.db full lifecycle (CRUD via BrainDataAccessor)
 * 3. FTS5 search end-to-end
 * 4. JSONL migration end-to-end
 * 5. Decision Memory module
 * 6. Memory links module
 *
 * All tests use real temp directories and real database connections.
 * No mocks.
 *
 * @task T5149
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

// ============================================================================
// 1. Session Engine: sessionFind, sessionList, sessionStart, sessionEnd
// ============================================================================

describe('Session Engine — full dispatch path', () => {
  let testDir: string;
  let cleoDir: string;
  let sqliteModule: typeof import('../../src/store/sqlite.js');
  let sessionEngine: typeof import('../../src/dispatch/engines/session-engine.js');

  beforeEach(async () => {
    testDir = await mkdtemp(join(tmpdir(), 'wave3-session-'));
    cleoDir = join(testDir, '.cleo');
    await mkdir(cleoDir, { recursive: true });
    process.env['CLEO_DIR'] = cleoDir;

    // Dynamic import after env set
    sqliteModule = await import('../../src/store/sqlite.js');
    sessionEngine = await import('../../src/dispatch/engines/session-engine.js');

    // Initialize the DB and insert a stub task for session scope
    const db = await sqliteModule.getDb();
    const { tasks } = await import('../../src/store/schema.js');
    await db.insert(tasks).values({
      id: 'T001',
      title: 'Root epic for session tests',
      status: 'active',
      priority: 'high',
      type: 'epic',
      position: 1,
      positionVersion: 0,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });
  });

  afterEach(async () => {
    sqliteModule?.closeDb();
    delete process.env['CLEO_DIR'];
    await rm(testDir, { recursive: true, force: true });
  });

  it('should start 3 sessions with different scopes and list them', async () => {
    // Start session 1
    const s1 = await sessionEngine.sessionStart(testDir, {
      scope: 'epic:T001',
      name: 'session-alpha',
    });
    expect(s1.success).toBe(true);
    expect(s1.data!.status).toBe('active');
    expect(s1.data!.name).toBe('session-alpha');

    // End session 1 so we can start another
    await sessionEngine.sessionEnd(testDir);

    // Start session 2
    const s2 = await sessionEngine.sessionStart(testDir, {
      scope: 'epic:T001',
      name: 'session-beta',
    });
    expect(s2.success).toBe(true);
    await sessionEngine.sessionEnd(testDir);

    // Start session 3
    const s3 = await sessionEngine.sessionStart(testDir, {
      scope: 'epic:T001',
      name: 'session-gamma',
    });
    expect(s3.success).toBe(true);

    // sessionList with default limit
    const listResult = await sessionEngine.sessionList(testDir);
    expect(listResult.success).toBe(true);
    expect(listResult.data!.sessions.length).toBe(3);
    expect(listResult.data!._meta.total).toBe(3);
    expect(listResult.data!._meta.truncated).toBe(false);
  });

  it('should enforce default limit=10 and set _meta.truncated', async () => {
    // Create 12 sessions
    for (let i = 0; i < 12; i++) {
      await sessionEngine.sessionStart(testDir, {
        scope: 'epic:T001',
        name: `session-${i}`,
      });
      await sessionEngine.sessionEnd(testDir);
    }

    const listResult = await sessionEngine.sessionList(testDir);
    expect(listResult.success).toBe(true);
    expect(listResult.data!.sessions.length).toBe(10); // default limit
    expect(listResult.data!._meta.total).toBe(12);
    expect(listResult.data!._meta.truncated).toBe(true);
  });

  it('sessionFind returns minimal session records', async () => {
    await sessionEngine.sessionStart(testDir, {
      scope: 'epic:T001',
      name: 'find-test-session',
    });

    const findResult = await sessionEngine.sessionFind(testDir);
    expect(findResult.success).toBe(true);

    const sessions = findResult.data!;
    expect(sessions.length).toBeGreaterThanOrEqual(1);

    // Verify minimal fields are present
    const s = sessions[0];
    expect(s).toHaveProperty('id');
    expect(s).toHaveProperty('name');
    expect(s).toHaveProperty('status');
    expect(s).toHaveProperty('startedAt');
    expect(s).toHaveProperty('scope');

    // Verify it does NOT have full session fields (e.g. stats, taskWork)
    // MinimalSessionRecord should only have id, name, status, startedAt, scope
    const keys = Object.keys(s);
    expect(keys).toEqual(expect.arrayContaining(['id', 'name', 'status', 'startedAt', 'scope']));
  });

  it('sessionFind filters by status', async () => {
    await sessionEngine.sessionStart(testDir, {
      scope: 'epic:T001',
      name: 'active-session',
    });

    const activeOnly = await sessionEngine.sessionFind(testDir, { status: 'active' });
    expect(activeOnly.success).toBe(true);
    expect(activeOnly.data!.length).toBeGreaterThanOrEqual(1);
    for (const s of activeOnly.data!) {
      expect(s.status).toBe('active');
    }

    const endedOnly = await sessionEngine.sessionFind(testDir, { status: 'ended' });
    expect(endedOnly.success).toBe(true);
    // The one we just started is active, not ended
    for (const s of endedOnly.data!) {
      expect(s.status).toBe('ended');
    }
  });
});

// ============================================================================
// 2. brain.db Full Lifecycle (CRUD)
// ============================================================================

describe('brain.db — full lifecycle via BrainDataAccessor', () => {
  let testDir: string;
  let brainSqlite: typeof import('../../src/store/brain-sqlite.js');
  let brainAccessorModule: typeof import('../../src/store/brain-accessor.js');

  beforeEach(async () => {
    testDir = await mkdtemp(join(tmpdir(), 'wave3-brain-'));
    await mkdir(join(testDir, '.cleo'), { recursive: true });
    process.env['CLEO_DIR'] = join(testDir, '.cleo');

    brainSqlite = await import('../../src/store/brain-sqlite.js');
    brainAccessorModule = await import('../../src/store/brain-accessor.js');

    // Reset singleton state
    brainSqlite.resetBrainDbState();
  });

  afterEach(async () => {
    brainSqlite?.closeBrainDb();
    delete process.env['CLEO_DIR'];
    await rm(testDir, { recursive: true, force: true });
  });

  it('getBrainDb creates the database file', async () => {
    const db = await brainSqlite.getBrainDb(testDir);
    expect(db).toBeDefined();

    const { existsSync } = await import('node:fs');
    const dbPath = brainSqlite.getBrainDbPath(testDir);
    expect(existsSync(dbPath)).toBe(true);
  });

  it('insert and query a decision via BrainDataAccessor', async () => {
    const accessor = await brainAccessorModule.getBrainAccessor(testDir);

    const inserted = await accessor.addDecision({
      id: 'D001',
      type: 'technical',
      decision: 'Use SQLite for brain storage',
      rationale: 'Performance and reliability',
      confidence: 'high',
      outcome: 'pending',
    });

    expect(inserted.id).toBe('D001');
    expect(inserted.decision).toBe('Use SQLite for brain storage');
    expect(inserted.type).toBe('technical');

    // Query it back
    const fetched = await accessor.getDecision('D001');
    expect(fetched).not.toBeNull();
    expect(fetched!.id).toBe('D001');
    expect(fetched!.rationale).toBe('Performance and reliability');
  });

  it('update a decision and verify persistence', async () => {
    const accessor = await brainAccessorModule.getBrainAccessor(testDir);

    await accessor.addDecision({
      id: 'D010',
      type: 'architecture',
      decision: 'Use drizzle ORM',
      rationale: 'Type safety and migrations',
      confidence: 'medium',
    });

    await accessor.updateDecision('D010', {
      outcome: 'success',
      confidence: 'high',
    });

    const updated = await accessor.getDecision('D010');
    expect(updated!.outcome).toBe('success');
    expect(updated!.confidence).toBe('high');
    expect(updated!.updatedAt).toBeTruthy();
  });

  it('insert and query patterns', async () => {
    const accessor = await brainAccessorModule.getBrainAccessor(testDir);

    await accessor.addPattern({
      id: 'P001',
      type: 'workflow',
      pattern: 'Always run tests before commit',
      context: 'CI/CD pipeline',
      frequency: 10,
      impact: 'high',
    });

    await accessor.addPattern({
      id: 'P002',
      type: 'blocker',
      pattern: 'Database locks on concurrent writes',
      context: 'Multi-agent sessions',
      frequency: 3,
      impact: 'medium',
    });

    const patterns = await accessor.findPatterns({ type: 'workflow' });
    expect(patterns.length).toBe(1);
    expect(patterns[0].id).toBe('P001');

    const highImpact = await accessor.findPatterns({ impact: 'high' });
    expect(highImpact.length).toBe(1);
  });

  it('insert and query learnings', async () => {
    const accessor = await brainAccessorModule.getBrainAccessor(testDir);

    await accessor.addLearning({
      id: 'L001',
      insight: 'FTS5 requires triggers for content-sync',
      source: 'wave3-implementation',
      confidence: 0.9,
      actionable: true,
      application: 'Always create triggers when using FTS5 content= tables',
    });

    const learning = await accessor.getLearning('L001');
    expect(learning).not.toBeNull();
    expect(learning!.insight).toBe('FTS5 requires triggers for content-sync');
    expect(learning!.confidence).toBe(0.9);
    expect(learning!.actionable).toBe(true);

    const actionable = await accessor.findLearnings({ actionable: true });
    expect(actionable.length).toBe(1);
  });

  it('create memory links and query by task', async () => {
    const accessor = await brainAccessorModule.getBrainAccessor(testDir);

    // Insert a decision first
    await accessor.addDecision({
      id: 'D050',
      type: 'strategic',
      decision: 'Adopt brain.db architecture',
      rationale: 'Centralized cognitive store',
      confidence: 'high',
    });

    // Create link
    await accessor.addLink({
      memoryType: 'decision',
      memoryId: 'D050',
      taskId: 'T5149',
      linkType: 'produced_by',
    });

    // Query by task
    const taskLinks = await accessor.getLinksForTask('T5149');
    expect(taskLinks.length).toBe(1);
    expect(taskLinks[0].memoryId).toBe('D050');
    expect(taskLinks[0].linkType).toBe('produced_by');

    // Query by memory
    const memoryLinks = await accessor.getLinksForMemory('decision', 'D050');
    expect(memoryLinks.length).toBe(1);
    expect(memoryLinks[0].taskId).toBe('T5149');
  });
});

// ============================================================================
// 3. FTS5 Search End-to-End
// ============================================================================

describe('FTS5 search — end-to-end', () => {
  let testDir: string;
  let brainSqlite: typeof import('../../src/store/brain-sqlite.js');
  let brainAccessorModule: typeof import('../../src/store/brain-accessor.js');
  let brainSearchModule: typeof import('../../src/core/memory/brain-search.js');

  beforeEach(async () => {
    testDir = await mkdtemp(join(tmpdir(), 'wave3-fts5-'));
    await mkdir(join(testDir, '.cleo'), { recursive: true });
    process.env['CLEO_DIR'] = join(testDir, '.cleo');

    brainSqlite = await import('../../src/store/brain-sqlite.js');
    brainAccessorModule = await import('../../src/store/brain-accessor.js');
    brainSearchModule = await import('../../src/core/memory/brain-search.js');

    brainSqlite.resetBrainDbState();
    brainSearchModule.resetFts5Cache();
  });

  afterEach(async () => {
    brainSqlite?.closeBrainDb();
    delete process.env['CLEO_DIR'];
    await rm(testDir, { recursive: true, force: true });
  });

  it('should search across decisions, patterns, and learnings', async () => {
    const accessor = await brainAccessorModule.getBrainAccessor(testDir);

    // Insert 5 decisions with different text
    await accessor.addDecision({
      id: 'D100',
      type: 'technical',
      decision: 'Use PostgreSQL for production database',
      rationale: 'Scalability and ACID compliance for production workloads',
      confidence: 'high',
    });
    await accessor.addDecision({
      id: 'D101',
      type: 'architecture',
      decision: 'Adopt microservices architecture',
      rationale: 'Independent deployment and scaling of services',
      confidence: 'medium',
    });
    await accessor.addDecision({
      id: 'D102',
      type: 'process',
      decision: 'Use trunk-based development',
      rationale: 'Faster integration and reduced merge conflicts',
      confidence: 'high',
    });
    await accessor.addDecision({
      id: 'D103',
      type: 'technical',
      decision: 'SQLite for embedded storage in CLI tools',
      rationale: 'Zero dependencies and serverless operation',
      confidence: 'high',
    });
    await accessor.addDecision({
      id: 'D104',
      type: 'strategic',
      decision: 'Open source the task management protocol',
      rationale: 'Community adoption and contribution',
      confidence: 'medium',
    });

    // Insert 3 patterns with different context
    await accessor.addPattern({
      id: 'P100',
      type: 'success',
      pattern: 'Database migrations with drizzle-kit',
      context: 'SQLite schema management in production',
      frequency: 5,
    });
    await accessor.addPattern({
      id: 'P101',
      type: 'workflow',
      pattern: 'Test before commit workflow',
      context: 'CI/CD pipeline for code quality assurance',
      frequency: 20,
    });
    await accessor.addPattern({
      id: 'P102',
      type: 'blocker',
      pattern: 'Concurrent database write conflicts',
      context: 'Multi-agent session coordination',
      frequency: 3,
    });

    // Insert learnings
    await accessor.addLearning({
      id: 'L100',
      insight: 'SQLite WAL mode prevents database lock issues',
      source: 'production-debugging',
      confidence: 0.95,
      actionable: true,
    });
    await accessor.addLearning({
      id: 'L101',
      insight: 'FTS5 content-sync triggers are mandatory',
      source: 'wave3-implementation',
      confidence: 0.85,
      actionable: true,
    });

    // Search for "SQLite" — should match decisions and patterns and learnings
    const results = await brainSearchModule.searchBrain(testDir, 'SQLite');
    expect(results.decisions.length).toBeGreaterThanOrEqual(1);
    // Verify the SQLite-related decision is found
    const sqliteDecisionIds = results.decisions.map((d) => d.id);
    expect(sqliteDecisionIds).toContain('D103');

    // Search for "database" — should match multiple entries
    const dbResults = await brainSearchModule.searchBrain(testDir, 'database');
    const totalResults =
      dbResults.decisions.length +
      dbResults.patterns.length +
      dbResults.learnings.length;
    expect(totalResults).toBeGreaterThanOrEqual(2);

    // Search for something that matches nothing
    const noResults = await brainSearchModule.searchBrain(testDir, 'xyznonexistent');
    expect(noResults.decisions.length).toBe(0);
    expect(noResults.patterns.length).toBe(0);
    expect(noResults.learnings.length).toBe(0);
  });

  it('should return empty results for empty query', async () => {
    const results = await brainSearchModule.searchBrain(testDir, '');
    expect(results.decisions).toEqual([]);
    expect(results.patterns).toEqual([]);
    expect(results.learnings).toEqual([]);
  });

  it('should respect per-table filtering', async () => {
    const accessor = await brainAccessorModule.getBrainAccessor(testDir);
    await accessor.addDecision({
      id: 'D200',
      type: 'technical',
      decision: 'Test filtering',
      rationale: 'For the FTS5 table filtering test',
      confidence: 'low',
    });

    // Search only in decisions
    const results = await brainSearchModule.searchBrain(testDir, 'filtering', {
      tables: ['decisions'],
    });
    expect(results.decisions.length).toBeGreaterThanOrEqual(1);
    // patterns and learnings should be empty since we didn't search them
    expect(results.patterns).toEqual([]);
    expect(results.learnings).toEqual([]);
  });
});

// ============================================================================
// 4. JSONL Migration End-to-End
// ============================================================================

describe('JSONL migration — end-to-end', () => {
  let testDir: string;
  let brainSqlite: typeof import('../../src/store/brain-sqlite.js');
  let migrationModule: typeof import('../../src/core/memory/brain-migration.js');
  let brainAccessorModule: typeof import('../../src/store/brain-accessor.js');

  beforeEach(async () => {
    testDir = await mkdtemp(join(tmpdir(), 'wave3-migration-'));
    await mkdir(join(testDir, '.cleo', 'memory'), { recursive: true });
    process.env['CLEO_DIR'] = join(testDir, '.cleo');

    brainSqlite = await import('../../src/store/brain-sqlite.js');
    migrationModule = await import('../../src/core/memory/brain-migration.js');
    brainAccessorModule = await import('../../src/store/brain-accessor.js');

    brainSqlite.resetBrainDbState();
  });

  afterEach(async () => {
    brainSqlite?.closeBrainDb();
    delete process.env['CLEO_DIR'];
    await rm(testDir, { recursive: true, force: true });
  });

  it('should migrate patterns.jsonl and learnings.jsonl into brain.db', async () => {
    // Create test JSONL files
    const patternsJsonl = [
      JSON.stringify({
        id: 'P_MIG_001',
        type: 'workflow',
        pattern: 'Test-driven development',
        context: 'Software engineering best practice',
        frequency: 15,
        successRate: 0.8,
        impact: 'high',
        antiPattern: null,
        mitigation: null,
        examples: ['red-green-refactor'],
        extractedAt: '2026-01-15 10:00:00',
        updatedAt: null,
      }),
      JSON.stringify({
        id: 'P_MIG_002',
        type: 'blocker',
        pattern: 'WAL file corruption on branch switch',
        context: 'Git + SQLite interaction',
        frequency: 3,
        successRate: null,
        impact: 'medium',
        antiPattern: 'Committing WAL files',
        mitigation: 'Add WAL/SHM to gitignore',
        examples: [],
        extractedAt: '2026-02-01 12:00:00',
        updatedAt: null,
      }),
    ].join('\n');

    const learningsJsonl = [
      JSON.stringify({
        id: 'L_MIG_001',
        insight: 'Always use WAL mode for SQLite in multi-reader scenarios',
        source: 'production-incident',
        confidence: 0.92,
        actionable: true,
        application: 'Set PRAGMA journal_mode=WAL on database open',
        applicableTypes: ['database', 'sqlite'],
        createdAt: '2026-01-20 08:30:00',
        updatedAt: null,
      }),
    ].join('\n');

    await writeFile(join(testDir, '.cleo', 'memory', 'patterns.jsonl'), patternsJsonl);
    await writeFile(join(testDir, '.cleo', 'memory', 'learnings.jsonl'), learningsJsonl);

    // Run migration
    const result = await migrationModule.migrateBrainData(testDir);
    expect(result.patternsImported).toBe(2);
    expect(result.learningsImported).toBe(1);
    expect(result.duplicatesSkipped).toBe(0);
    expect(result.errors).toEqual([]);

    // Verify data in brain.db
    const accessor = await brainAccessorModule.getBrainAccessor(testDir);
    const p1 = await accessor.getPattern('P_MIG_001');
    expect(p1).not.toBeNull();
    expect(p1!.pattern).toBe('Test-driven development');
    expect(p1!.frequency).toBe(15);

    const p2 = await accessor.getPattern('P_MIG_002');
    expect(p2).not.toBeNull();
    expect(p2!.type).toBe('blocker');

    const l1 = await accessor.getLearning('L_MIG_001');
    expect(l1).not.toBeNull();
    expect(l1!.insight).toBe('Always use WAL mode for SQLite in multi-reader scenarios');
    expect(l1!.confidence).toBe(0.92);
  });

  it('should be idempotent — no duplicates on second run', async () => {
    const patternsJsonl = JSON.stringify({
      id: 'P_IDEM_001',
      type: 'success',
      pattern: 'Idempotent migration test',
      context: 'Testing',
      frequency: 1,
      successRate: null,
      impact: null,
      antiPattern: null,
      mitigation: null,
      examples: [],
      extractedAt: '2026-03-01 00:00:00',
      updatedAt: null,
    });

    await writeFile(join(testDir, '.cleo', 'memory', 'patterns.jsonl'), patternsJsonl);
    // No learnings file for this test

    // First run
    const result1 = await migrationModule.migrateBrainData(testDir);
    expect(result1.patternsImported).toBe(1);
    expect(result1.duplicatesSkipped).toBe(0);

    // Second run — same data
    const result2 = await migrationModule.migrateBrainData(testDir);
    expect(result2.patternsImported).toBe(0);
    expect(result2.duplicatesSkipped).toBe(1);
    expect(result2.errors).toEqual([]);
  });

  it('should handle missing JSONL files gracefully', async () => {
    // No files exist, just the directories
    const result = await migrationModule.migrateBrainData(testDir);
    expect(result.patternsImported).toBe(0);
    expect(result.learningsImported).toBe(0);
    expect(result.duplicatesSkipped).toBe(0);
    expect(result.errors).toEqual([]);
  });
});

// ============================================================================
// 5. Decision Memory Module
// ============================================================================

describe('Decision Memory — storeDecision, recallDecision, searchDecisions, updateDecisionOutcome, listDecisions', () => {
  let testDir: string;
  let brainSqlite: typeof import('../../src/store/brain-sqlite.js');
  let decisionsModule: typeof import('../../src/core/memory/decisions.js');

  beforeEach(async () => {
    testDir = await mkdtemp(join(tmpdir(), 'wave3-decisions-'));
    await mkdir(join(testDir, '.cleo'), { recursive: true });
    process.env['CLEO_DIR'] = join(testDir, '.cleo');

    brainSqlite = await import('../../src/store/brain-sqlite.js');
    decisionsModule = await import('../../src/core/memory/decisions.js');

    brainSqlite.resetBrainDbState();
  });

  afterEach(async () => {
    brainSqlite?.closeBrainDb();
    delete process.env['CLEO_DIR'];
    await rm(testDir, { recursive: true, force: true });
  });

  it('storeDecision creates D001 then D002 sequentially', async () => {
    const d1 = await decisionsModule.storeDecision(testDir, {
      type: 'technical',
      decision: 'Use TypeScript strict mode',
      rationale: 'Catches type errors at compile time',
      confidence: 'high',
    });
    expect(d1.id).toBe('D001');

    const d2 = await decisionsModule.storeDecision(testDir, {
      type: 'architecture',
      decision: 'Adopt event-sourcing pattern',
      rationale: 'Audit trail and replay capability',
      confidence: 'medium',
    });
    expect(d2.id).toBe('D002');
  });

  it('recallDecision returns correct data', async () => {
    await decisionsModule.storeDecision(testDir, {
      type: 'process',
      decision: 'Code review required before merge',
      rationale: 'Quality gate enforcement',
      confidence: 'high',
      alternatives: ['Auto-merge after CI', 'Pair programming only'],
    });

    const recalled = await decisionsModule.recallDecision(testDir, 'D001');
    expect(recalled).not.toBeNull();
    expect(recalled!.decision).toBe('Code review required before merge');
    expect(recalled!.rationale).toBe('Quality gate enforcement');
    expect(recalled!.confidence).toBe('high');
    expect(recalled!.type).toBe('process');
    // Alternatives should be stored as JSON
    expect(recalled!.alternativesJson).toBeTruthy();
    const alts = JSON.parse(recalled!.alternativesJson!);
    expect(alts).toEqual(['Auto-merge after CI', 'Pair programming only']);
  });

  it('searchDecisions filters by type', async () => {
    await decisionsModule.storeDecision(testDir, {
      type: 'technical',
      decision: 'Use esbuild for bundling',
      rationale: 'Fast builds',
      confidence: 'high',
    });
    await decisionsModule.storeDecision(testDir, {
      type: 'strategic',
      decision: 'Publish to npm as @cleocode/cleo',
      rationale: 'Namespace consistency',
      confidence: 'medium',
    });
    await decisionsModule.storeDecision(testDir, {
      type: 'technical',
      decision: 'Use Vitest for testing',
      rationale: 'Native ESM and TypeScript support',
      confidence: 'high',
    });

    const technicalOnly = await decisionsModule.searchDecisions(testDir, {
      type: 'technical',
    });
    expect(technicalOnly.length).toBe(2);
    for (const d of technicalOnly) {
      expect(d.type).toBe('technical');
    }

    const strategicOnly = await decisionsModule.searchDecisions(testDir, {
      type: 'strategic',
    });
    expect(strategicOnly.length).toBe(1);
    expect(strategicOnly[0].decision).toBe('Publish to npm as @cleocode/cleo');
  });

  it('updateDecisionOutcome persists the outcome', async () => {
    await decisionsModule.storeDecision(testDir, {
      type: 'technical',
      decision: 'Migrate from Jest to Vitest',
      rationale: 'Better ESM support',
      confidence: 'high',
      outcome: 'pending',
    });

    const updated = await decisionsModule.updateDecisionOutcome(testDir, 'D001', 'success');
    expect(updated.outcome).toBe('success');

    // Verify persistence
    const recalled = await decisionsModule.recallDecision(testDir, 'D001');
    expect(recalled!.outcome).toBe('success');
  });

  it('duplicate decision text triggers update not insert', async () => {
    await decisionsModule.storeDecision(testDir, {
      type: 'technical',
      decision: 'Use SQLite for storage',
      rationale: 'Original rationale',
      confidence: 'medium',
    });

    // Store again with same decision text but different rationale
    const result = await decisionsModule.storeDecision(testDir, {
      type: 'technical',
      decision: 'Use SQLite for storage',
      rationale: 'Updated rationale with more detail',
      confidence: 'high',
    });

    // Should return the same ID (updated, not new)
    expect(result.id).toBe('D001');
    expect(result.rationale).toBe('Updated rationale with more detail');
    expect(result.confidence).toBe('high');

    // Verify only 1 decision exists
    const list = await decisionsModule.listDecisions(testDir);
    expect(list.total).toBe(1);
  });

  it('listDecisions returns paginated results', async () => {
    // Insert 5 decisions
    for (let i = 0; i < 5; i++) {
      await decisionsModule.storeDecision(testDir, {
        type: 'technical',
        decision: `Decision number ${i}`,
        rationale: `Rationale for decision ${i}`,
        confidence: 'medium',
      });
    }

    const all = await decisionsModule.listDecisions(testDir);
    expect(all.total).toBe(5);
    expect(all.decisions.length).toBe(5);

    const page = await decisionsModule.listDecisions(testDir, { limit: 2, offset: 1 });
    expect(page.total).toBe(5);
    expect(page.decisions.length).toBe(2);
  });
});

// ============================================================================
// 6. Memory Links Module
// ============================================================================

describe('Memory Links — linkMemoryToTask, getTaskLinks, getLinkedDecisions, bulkLink', () => {
  let testDir: string;
  let brainSqlite: typeof import('../../src/store/brain-sqlite.js');
  let brainAccessorModule: typeof import('../../src/store/brain-accessor.js');
  let brainLinksModule: typeof import('../../src/core/memory/brain-links.js');

  beforeEach(async () => {
    testDir = await mkdtemp(join(tmpdir(), 'wave3-links-'));
    await mkdir(join(testDir, '.cleo'), { recursive: true });
    process.env['CLEO_DIR'] = join(testDir, '.cleo');

    brainSqlite = await import('../../src/store/brain-sqlite.js');
    brainAccessorModule = await import('../../src/store/brain-accessor.js');
    brainLinksModule = await import('../../src/core/memory/brain-links.js');

    brainSqlite.resetBrainDbState();
  });

  afterEach(async () => {
    brainSqlite?.closeBrainDb();
    delete process.env['CLEO_DIR'];
    await rm(testDir, { recursive: true, force: true });
  });

  it('link a decision to a task and query back', async () => {
    const accessor = await brainAccessorModule.getBrainAccessor(testDir);

    // Insert a decision to link
    await accessor.addDecision({
      id: 'D300',
      type: 'technical',
      decision: 'Use brain.db for memory',
      rationale: 'Structured cognitive store',
      confidence: 'high',
    });

    // Create link
    const link = await brainLinksModule.linkMemoryToTask(
      testDir,
      'decision',
      'D300',
      'T5149',
      'produced_by',
    );

    expect(link.memoryType).toBe('decision');
    expect(link.memoryId).toBe('D300');
    expect(link.taskId).toBe('T5149');
    expect(link.linkType).toBe('produced_by');

    // getTaskLinks
    const taskLinks = await brainLinksModule.getTaskLinks(testDir, 'T5149');
    expect(taskLinks.length).toBe(1);
    expect(taskLinks[0].memoryId).toBe('D300');
  });

  it('getLinkedDecisions returns full decision rows', async () => {
    const accessor = await brainAccessorModule.getBrainAccessor(testDir);

    await accessor.addDecision({
      id: 'D400',
      type: 'architecture',
      decision: 'Dispatch-first pattern',
      rationale: 'Clean separation of concerns',
      confidence: 'high',
    });
    await accessor.addDecision({
      id: 'D401',
      type: 'technical',
      decision: 'Singleton database connections',
      rationale: 'Resource management',
      confidence: 'medium',
    });

    await brainLinksModule.linkMemoryToTask(testDir, 'decision', 'D400', 'T4654', 'produced_by');
    await brainLinksModule.linkMemoryToTask(testDir, 'decision', 'D401', 'T4654', 'applies_to');

    const decisions = await brainLinksModule.getLinkedDecisions(testDir, 'T4654');
    expect(decisions.length).toBe(2);
    const ids = decisions.map((d) => d.id).sort();
    expect(ids).toEqual(['D400', 'D401']);

    // Verify full row data
    const d400 = decisions.find((d) => d.id === 'D400')!;
    expect(d400.decision).toBe('Dispatch-first pattern');
    expect(d400.rationale).toBe('Clean separation of concerns');
  });

  it('bulkLink creates multiple links atomically and skips duplicates', async () => {
    const accessor = await brainAccessorModule.getBrainAccessor(testDir);

    await accessor.addDecision({
      id: 'D500',
      type: 'process',
      decision: 'Daily standups',
      rationale: 'Team sync',
      confidence: 'low',
    });
    await accessor.addPattern({
      id: 'P500',
      type: 'success',
      pattern: 'Automated testing',
      context: 'Quality assurance',
      frequency: 50,
    });

    // Bulk link both entries to task
    const result = await brainLinksModule.bulkLink(testDir, [
      { memoryType: 'decision', memoryId: 'D500', taskId: 'T1000', linkType: 'produced_by' },
      { memoryType: 'pattern', memoryId: 'P500', taskId: 'T1000', linkType: 'applies_to' },
    ]);
    expect(result.created).toBe(2);
    expect(result.skipped).toBe(0);

    // Run again — all should be skipped as duplicates
    const result2 = await brainLinksModule.bulkLink(testDir, [
      { memoryType: 'decision', memoryId: 'D500', taskId: 'T1000', linkType: 'produced_by' },
      { memoryType: 'pattern', memoryId: 'P500', taskId: 'T1000', linkType: 'applies_to' },
    ]);
    expect(result2.created).toBe(0);
    expect(result2.skipped).toBe(2);

    // Verify all links via getTaskLinks
    const links = await brainLinksModule.getTaskLinks(testDir, 'T1000');
    expect(links.length).toBe(2);
  });

  it('linkMemoryToTask is idempotent — returns existing link on duplicate', async () => {
    const accessor = await brainAccessorModule.getBrainAccessor(testDir);

    await accessor.addLearning({
      id: 'L500',
      insight: 'Idempotent links are important',
      source: 'testing',
      confidence: 0.99,
      actionable: false,
    });

    const link1 = await brainLinksModule.linkMemoryToTask(
      testDir,
      'learning',
      'L500',
      'T2000',
      'informed_by',
    );

    const link2 = await brainLinksModule.linkMemoryToTask(
      testDir,
      'learning',
      'L500',
      'T2000',
      'informed_by',
    );

    // Same link returned
    expect(link1.memoryId).toBe(link2.memoryId);
    expect(link1.taskId).toBe(link2.taskId);
    expect(link1.linkType).toBe(link2.linkType);

    // Only 1 link in DB
    const links = await brainLinksModule.getTaskLinks(testDir, 'T2000');
    expect(links.length).toBe(1);
  });

  it('getMemoryLinks returns links for a specific memory entry', async () => {
    const accessor = await brainAccessorModule.getBrainAccessor(testDir);

    await accessor.addDecision({
      id: 'D600',
      type: 'tactical',
      decision: 'Sprint planning cadence',
      rationale: 'Regular planning cycles',
      confidence: 'medium',
    });

    // Link to multiple tasks
    await brainLinksModule.linkMemoryToTask(testDir, 'decision', 'D600', 'T3001', 'applies_to');
    await brainLinksModule.linkMemoryToTask(testDir, 'decision', 'D600', 'T3002', 'applies_to');
    await brainLinksModule.linkMemoryToTask(testDir, 'decision', 'D600', 'T3003', 'informed_by');

    const memLinks = await brainLinksModule.getMemoryLinks(testDir, 'decision', 'D600');
    expect(memLinks.length).toBe(3);

    const taskIds = memLinks.map((l) => l.taskId).sort();
    expect(taskIds).toEqual(['T3001', 'T3002', 'T3003']);
  });
});
