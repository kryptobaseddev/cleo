/**
 * Tests for claude-mem to brain.db migration.
 *
 * Creates a temporary claude-mem.db fixture with the expected schema,
 * inserts test data, then verifies the migration imports correctly
 * into brain.db.
 *
 * @task T5143
 * @epic T5149
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createRequire } from 'node:module';
import type { DatabaseSync as _DatabaseSyncType } from 'node:sqlite';

// Runtime-load node:sqlite
const _require = createRequire(import.meta.url);
type DatabaseSync = _DatabaseSyncType;
const { DatabaseSync } = _require('node:sqlite') as {
  DatabaseSync: new (...args: ConstructorParameters<typeof _DatabaseSyncType>) => DatabaseSync;
};

let tempDir: string;
let cleoDir: string;
let claudeMemDbPath: string;

/**
 * Create a claude-mem.db fixture with the expected schema and seed data.
 */
function createClaudeMemFixture(dbPath: string): DatabaseSync {
  const db = new DatabaseSync(dbPath);

  db.exec(`
    CREATE TABLE observations (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      type TEXT NOT NULL,
      title TEXT NOT NULL,
      subtitle TEXT,
      narrative TEXT,
      facts TEXT,
      concepts TEXT,
      project TEXT,
      files_read TEXT,
      files_modified TEXT,
      created_at TEXT DEFAULT (datetime('now')),
      updated_at TEXT
    );

    CREATE TABLE session_summaries (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id TEXT,
      summary TEXT,
      learned TEXT,
      created_at TEXT
    );
  `);

  return db;
}

/**
 * Insert observation rows into the fixture database.
 */
function seedObservations(db: DatabaseSync, observations: Array<{
  type: string;
  title: string;
  subtitle?: string | null;
  narrative?: string | null;
  facts?: string | null;
  concepts?: string | null;
  project?: string | null;
  files_read?: string | null;
  files_modified?: string | null;
  created_at?: string;
}>): void {
  const stmt = db.prepare(`
    INSERT INTO observations (type, title, subtitle, narrative, facts, concepts, project, files_read, files_modified, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  for (const o of observations) {
    stmt.run(
      o.type,
      o.title,
      o.subtitle ?? null,
      o.narrative ?? null,
      o.facts ?? null,
      o.concepts ?? null,
      o.project ?? null,
      o.files_read ?? null,
      o.files_modified ?? null,
      o.created_at ?? '2026-01-15 10:00:00',
    );
  }
}

/**
 * Insert session summary rows into the fixture database.
 */
function seedSessionSummaries(db: DatabaseSync, summaries: Array<{
  session_id?: string | null;
  summary?: string | null;
  learned?: string | null;
  created_at?: string;
}>): void {
  const stmt = db.prepare(`
    INSERT INTO session_summaries (session_id, summary, learned, created_at)
    VALUES (?, ?, ?, ?)
  `);

  for (const s of summaries) {
    stmt.run(
      s.session_id ?? null,
      s.summary ?? null,
      s.learned ?? null,
      s.created_at ?? '2026-01-15 12:00:00',
    );
  }
}

describe('Claude-mem Migration', () => {
  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'cleo-claude-mem-migration-'));
    cleoDir = join(tempDir, '.cleo');
    await mkdir(cleoDir, { recursive: true });
    process.env['CLEO_DIR'] = cleoDir;

    // Create the fixture claude-mem.db in the temp directory
    claudeMemDbPath = join(tempDir, 'claude-mem.db');
  });

  afterEach(async () => {
    const { closeBrainDb } = await import('../../../store/brain-sqlite.js');
    closeBrainDb();
    delete process.env['CLEO_DIR'];
    await rm(tempDir, { recursive: true, force: true });
  });

  it('should import observations from claude-mem.db', async () => {
    const { migrateClaudeMem } = await import('../claude-mem-migration.js');
    const { closeBrainDb } = await import('../../../store/brain-sqlite.js');
    closeBrainDb();

    const sourceDb = createClaudeMemFixture(claudeMemDbPath);
    seedObservations(sourceDb, [
      {
        type: 'discovery',
        title: 'Found new API pattern',
        narrative: 'REST endpoints follow resource naming',
        facts: '["fact1","fact2"]',
        concepts: '["REST","API"]',
        project: 'my-project',
      },
      {
        type: 'change',
        title: 'Refactored auth module',
        subtitle: 'Auth v2',
        narrative: 'Moved to JWT-based auth',
        files_modified: '["src/auth.ts"]',
      },
      {
        type: 'feature',
        title: 'Added search functionality',
        narrative: 'Full-text search via FTS5',
      },
      {
        type: 'bugfix',
        title: 'Fixed race condition in writes',
        narrative: 'Added file locking',
        files_read: '["src/store.ts"]',
        files_modified: '["src/store.ts","src/lock.ts"]',
      },
      {
        type: 'refactor',
        title: 'Simplified config loading',
        narrative: 'Single source of truth for config',
      },
    ]);
    sourceDb.close();

    const result = await migrateClaudeMem(tempDir, { sourcePath: claudeMemDbPath });

    expect(result.observationsImported).toBe(5);
    expect(result.observationsSkipped).toBe(0);
    expect(result.decisionsImported).toBe(0);
    expect(result.learningsImported).toBe(0);
    expect(result.errors).toHaveLength(0);
    expect(result.dryRun).toBe(false);

    // Verify observations in brain.db
    const { getBrainNativeDb } = await import('../../../store/brain-sqlite.js');
    const nativeDb = getBrainNativeDb()!;
    const rows = nativeDb.prepare('SELECT * FROM brain_observations ORDER BY id').all() as Array<Record<string, unknown>>;
    expect(rows).toHaveLength(5);
    expect(rows[0]!['id']).toBe('CM-1');
    expect(rows[0]!['source_type']).toBe('claude-mem');
    expect(rows[0]!['type']).toBe('discovery');
    expect(rows[0]!['title']).toBe('Found new API pattern');
    expect(rows[0]!['facts_json']).toBe('["fact1","fact2"]');
  });

  it('should create brain_decisions for decision-typed observations', async () => {
    const { migrateClaudeMem } = await import('../claude-mem-migration.js');
    const { closeBrainDb } = await import('../../../store/brain-sqlite.js');
    closeBrainDb();

    const sourceDb = createClaudeMemFixture(claudeMemDbPath);
    seedObservations(sourceDb, [
      {
        type: 'decision',
        title: 'Use SQLite for storage',
        narrative: 'SQLite provides ACID, zero-config deployment',
        created_at: '2026-01-10 09:00:00',
      },
      {
        type: 'decision',
        title: 'Adopt ESM modules',
        narrative: 'ESM is the future of JavaScript',
      },
      {
        type: 'discovery',
        title: 'Not a decision',
        narrative: 'This should not create a decision entry',
      },
    ]);
    sourceDb.close();

    const result = await migrateClaudeMem(tempDir, { sourcePath: claudeMemDbPath });

    expect(result.observationsImported).toBe(3);
    expect(result.decisionsImported).toBe(2);
    expect(result.errors).toHaveLength(0);

    // Verify decisions in brain.db
    const { getBrainNativeDb } = await import('../../../store/brain-sqlite.js');
    const nativeDb = getBrainNativeDb()!;
    const decisions = nativeDb.prepare('SELECT * FROM brain_decisions ORDER BY id').all() as Array<Record<string, unknown>>;
    expect(decisions).toHaveLength(2);
    expect(decisions[0]!['id']).toBe('CMD-1');
    expect(decisions[0]!['type']).toBe('tactical');
    expect(decisions[0]!['decision']).toBe('Use SQLite for storage');
    expect(decisions[0]!['rationale']).toBe('SQLite provides ACID, zero-config deployment');
    expect(decisions[0]!['confidence']).toBe('medium');
  });

  it('should create brain_learnings from session summaries', async () => {
    const { migrateClaudeMem } = await import('../claude-mem-migration.js');
    const { closeBrainDb } = await import('../../../store/brain-sqlite.js');
    closeBrainDb();

    const sourceDb = createClaudeMemFixture(claudeMemDbPath);
    seedSessionSummaries(sourceDb, [
      {
        session_id: 'sess-abc',
        summary: 'Worked on migration',
        learned: '["Atomic writes prevent corruption","WAL mode improves concurrency"]',
        created_at: '2026-01-15 14:00:00',
      },
      {
        session_id: 'sess-def',
        summary: 'Fixed bugs',
        learned: 'Always validate input before processing',
      },
      {
        session_id: 'sess-ghi',
        summary: 'No learnings here',
        learned: null,
      },
    ]);
    sourceDb.close();

    const result = await migrateClaudeMem(tempDir, { sourcePath: claudeMemDbPath });

    expect(result.learningsImported).toBe(2);
    expect(result.observationsImported).toBe(0);
    expect(result.errors).toHaveLength(0);

    // Verify learnings in brain.db
    const { getBrainNativeDb } = await import('../../../store/brain-sqlite.js');
    const nativeDb = getBrainNativeDb()!;
    const learnings = nativeDb.prepare('SELECT * FROM brain_learnings ORDER BY id').all() as Array<Record<string, unknown>>;
    expect(learnings).toHaveLength(2);

    expect(learnings[0]!['id']).toBe('CML-1');
    expect(learnings[0]!['insight']).toBe('Atomic writes prevent corruption; WAL mode improves concurrency');
    expect(learnings[0]!['source']).toBe('claude-mem session sess-abc');
    expect(learnings[0]!['confidence']).toBe(0.5);

    expect(learnings[1]!['id']).toBe('CML-2');
    expect(learnings[1]!['insight']).toBe('Always validate input before processing');
    expect(learnings[1]!['source']).toBe('claude-mem session sess-def');
  });

  it('should be idempotent — skip already-imported entries on re-run', async () => {
    const { migrateClaudeMem } = await import('../claude-mem-migration.js');
    const { closeBrainDb } = await import('../../../store/brain-sqlite.js');
    closeBrainDb();

    const sourceDb = createClaudeMemFixture(claudeMemDbPath);
    seedObservations(sourceDb, [
      { type: 'discovery', title: 'Observation 1', narrative: 'First observation' },
      { type: 'decision', title: 'Decision 1', narrative: 'First decision' },
    ]);
    seedSessionSummaries(sourceDb, [
      { session_id: 'sess-1', learned: 'Learning 1' },
    ]);
    sourceDb.close();

    // First run
    const first = await migrateClaudeMem(tempDir, { sourcePath: claudeMemDbPath });
    expect(first.observationsImported).toBe(2);
    expect(first.decisionsImported).toBe(1);
    expect(first.learningsImported).toBe(1);
    expect(first.observationsSkipped).toBe(0);

    // Second run — everything should be skipped
    const second = await migrateClaudeMem(tempDir, { sourcePath: claudeMemDbPath });
    expect(second.observationsImported).toBe(0);
    expect(second.decisionsImported).toBe(0);
    expect(second.learningsImported).toBe(0);
    expect(second.observationsSkipped).toBe(2);
    expect(second.errors).toHaveLength(0);
  });

  it('should support dry run without inserting data', async () => {
    const { migrateClaudeMem } = await import('../claude-mem-migration.js');
    const { closeBrainDb } = await import('../../../store/brain-sqlite.js');
    closeBrainDb();

    const sourceDb = createClaudeMemFixture(claudeMemDbPath);
    seedObservations(sourceDb, [
      { type: 'discovery', title: 'Obs 1', narrative: 'Test' },
      { type: 'decision', title: 'Dec 1', narrative: 'Test decision' },
      { type: 'feature', title: 'Feat 1', narrative: 'Test feature' },
    ]);
    seedSessionSummaries(sourceDb, [
      { session_id: 'sess-dry', learned: 'Dry run learning' },
    ]);
    sourceDb.close();

    const result = await migrateClaudeMem(tempDir, {
      sourcePath: claudeMemDbPath,
      dryRun: true,
    });

    expect(result.dryRun).toBe(true);
    expect(result.observationsImported).toBe(3);
    expect(result.decisionsImported).toBe(1);
    expect(result.learningsImported).toBe(1);

    // Verify nothing was actually inserted
    const { getBrainNativeDb } = await import('../../../store/brain-sqlite.js');
    const nativeDb = getBrainNativeDb()!;
    const obs = nativeDb.prepare('SELECT COUNT(*) as cnt FROM brain_observations').get() as Record<string, unknown>;
    expect(obs['cnt']).toBe(0);

    const decs = nativeDb.prepare('SELECT COUNT(*) as cnt FROM brain_decisions').get() as Record<string, unknown>;
    expect(decs['cnt']).toBe(0);

    const learns = nativeDb.prepare('SELECT COUNT(*) as cnt FROM brain_learnings').get() as Record<string, unknown>;
    expect(learns['cnt']).toBe(0);
  });

  it('should apply project tag override', async () => {
    const { migrateClaudeMem } = await import('../claude-mem-migration.js');
    const { closeBrainDb } = await import('../../../store/brain-sqlite.js');
    closeBrainDb();

    const sourceDb = createClaudeMemFixture(claudeMemDbPath);
    seedObservations(sourceDb, [
      { type: 'discovery', title: 'Obs with project', project: 'original-project' },
    ]);
    sourceDb.close();

    const result = await migrateClaudeMem(tempDir, {
      sourcePath: claudeMemDbPath,
      project: 'override-project',
    });

    expect(result.observationsImported).toBe(1);

    const { getBrainNativeDb } = await import('../../../store/brain-sqlite.js');
    const nativeDb = getBrainNativeDb()!;
    const row = nativeDb.prepare('SELECT project FROM brain_observations WHERE id = ?').get('CM-1') as Record<string, unknown>;
    expect(row['project']).toBe('override-project');
  });

  it('should throw if source database does not exist', async () => {
    const { migrateClaudeMem } = await import('../claude-mem-migration.js');
    const { closeBrainDb } = await import('../../../store/brain-sqlite.js');
    closeBrainDb();

    await expect(
      migrateClaudeMem(tempDir, { sourcePath: join(tempDir, 'nonexistent.db') }),
    ).rejects.toThrow('claude-mem database not found');
  });

  it('should handle observations with all fields populated', async () => {
    const { migrateClaudeMem } = await import('../claude-mem-migration.js');
    const { closeBrainDb } = await import('../../../store/brain-sqlite.js');
    closeBrainDb();

    const sourceDb = createClaudeMemFixture(claudeMemDbPath);
    seedObservations(sourceDb, [
      {
        type: 'feature',
        title: 'Full-featured observation',
        subtitle: 'Subtitle text',
        narrative: 'Detailed narrative',
        facts: '["fact-a","fact-b","fact-c"]',
        concepts: '["concept-x"]',
        project: 'test-project',
        files_read: '["src/a.ts","src/b.ts"]',
        files_modified: '["src/c.ts"]',
        created_at: '2026-02-01 08:30:00',
      },
    ]);
    sourceDb.close();

    const result = await migrateClaudeMem(tempDir, { sourcePath: claudeMemDbPath });
    expect(result.observationsImported).toBe(1);
    expect(result.errors).toHaveLength(0);

    const { getBrainNativeDb } = await import('../../../store/brain-sqlite.js');
    const nativeDb = getBrainNativeDb()!;
    const row = nativeDb.prepare('SELECT * FROM brain_observations WHERE id = ?').get('CM-1') as Record<string, unknown>;

    expect(row['type']).toBe('feature');
    expect(row['title']).toBe('Full-featured observation');
    expect(row['subtitle']).toBe('Subtitle text');
    expect(row['narrative']).toBe('Detailed narrative');
    expect(row['facts_json']).toBe('["fact-a","fact-b","fact-c"]');
    expect(row['concepts_json']).toBe('["concept-x"]');
    expect(row['project']).toBe('test-project');
    expect(row['files_read_json']).toBe('["src/a.ts","src/b.ts"]');
    expect(row['files_modified_json']).toBe('["src/c.ts"]');
    expect(row['created_at']).toBe('2026-02-01 08:30:00');
  });

  it('should map unknown observation types to discovery', async () => {
    const { migrateClaudeMem } = await import('../claude-mem-migration.js');
    const { closeBrainDb } = await import('../../../store/brain-sqlite.js');
    closeBrainDb();

    const sourceDb = createClaudeMemFixture(claudeMemDbPath);
    // Insert directly with an unknown type to bypass any validation
    sourceDb.prepare(
      'INSERT INTO observations (type, title, created_at) VALUES (?, ?, ?)',
    ).run('unknown_type', 'Unknown type obs', '2026-01-20 10:00:00');
    sourceDb.close();

    const result = await migrateClaudeMem(tempDir, { sourcePath: claudeMemDbPath });
    expect(result.observationsImported).toBe(1);

    const { getBrainNativeDb } = await import('../../../store/brain-sqlite.js');
    const nativeDb = getBrainNativeDb()!;
    const row = nativeDb.prepare('SELECT type FROM brain_observations WHERE id = ?').get('CM-1') as Record<string, unknown>;
    expect(row['type']).toBe('discovery');
  });

  it('should handle decisions with null narrative using fallback rationale', async () => {
    const { migrateClaudeMem } = await import('../claude-mem-migration.js');
    const { closeBrainDb } = await import('../../../store/brain-sqlite.js');
    closeBrainDb();

    const sourceDb = createClaudeMemFixture(claudeMemDbPath);
    seedObservations(sourceDb, [
      { type: 'decision', title: 'Decision without rationale', narrative: null },
    ]);
    sourceDb.close();

    const result = await migrateClaudeMem(tempDir, { sourcePath: claudeMemDbPath });
    expect(result.decisionsImported).toBe(1);

    const { getBrainNativeDb } = await import('../../../store/brain-sqlite.js');
    const nativeDb = getBrainNativeDb()!;
    const row = nativeDb.prepare('SELECT rationale FROM brain_decisions WHERE id = ?').get('CMD-1') as Record<string, unknown>;
    expect(row['rationale']).toBe('Imported from claude-mem');
  });

  it('should handle session summaries with JSON array learned field', async () => {
    const { migrateClaudeMem } = await import('../claude-mem-migration.js');
    const { closeBrainDb } = await import('../../../store/brain-sqlite.js');
    closeBrainDb();

    const sourceDb = createClaudeMemFixture(claudeMemDbPath);
    seedSessionSummaries(sourceDb, [
      {
        session_id: 'sess-json',
        learned: JSON.stringify(['First thing', 'Second thing', 'Third thing']),
      },
    ]);
    sourceDb.close();

    const result = await migrateClaudeMem(tempDir, { sourcePath: claudeMemDbPath });
    expect(result.learningsImported).toBe(1);

    const { getBrainNativeDb } = await import('../../../store/brain-sqlite.js');
    const nativeDb = getBrainNativeDb()!;
    const row = nativeDb.prepare('SELECT insight FROM brain_learnings WHERE id = ?').get('CML-1') as Record<string, unknown>;
    expect(row['insight']).toBe('First thing; Second thing; Third thing');
  });

  it('should skip session summaries with empty or whitespace-only learned field', async () => {
    const { migrateClaudeMem } = await import('../claude-mem-migration.js');
    const { closeBrainDb } = await import('../../../store/brain-sqlite.js');
    closeBrainDb();

    const sourceDb = createClaudeMemFixture(claudeMemDbPath);
    seedSessionSummaries(sourceDb, [
      { session_id: 'sess-empty', learned: '' },
      { session_id: 'sess-space', learned: '   ' },
      { session_id: 'sess-valid', learned: 'Valid learning' },
    ]);
    sourceDb.close();

    const result = await migrateClaudeMem(tempDir, { sourcePath: claudeMemDbPath });
    expect(result.learningsImported).toBe(1);
  });
});
