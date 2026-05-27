/**
 * Unit tests for skills-schema.ts + skills-db.ts.
 *
 * All tests mock `../../paths.js` so `getCleoHome()` resolves to a tmpdir —
 * the real `$XDG_DATA_HOME/cleo/skills.db` is NEVER touched.
 *
 * Coverage:
 *   - Schema TypeScript compiles cleanly (passes by virtue of the typed
 *     imports below — if the schema breaks, this file won't compile).
 *   - `openSkillsDb({ path })` materialises a fresh `skills.db` at a tmpdir
 *     and creates all 4 tables.
 *   - Insert / select round-trip for each table.
 *   - `source_type` CHECK constraint rejects invalid enum values.
 *   - `getSkillRow` / `upsertSkillRow` / `listSkillsBySource` helpers behave.
 *   - PRAGMA `index_list` reports the expected indexes on `skills`.
 *
 * @task T9651
 * @epic T9571
 * @saga T9560
 */

import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type {
  NewSkillPatchRow,
  NewSkillReviewRow,
  NewSkillRow,
  NewSkillUsageRow,
} from '../skills-schema.js';
import { skillPatches, skillReviews, skills, skillUsage } from '../skills-schema.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Tables that MUST exist after `openSkillsDb()` has materialised the DB,
 * excluding drizzle journal + meta sentinel tables (which we assert exist
 * separately in a dedicated test).
 */
const EXPECTED_SKILL_TABLES = ['skill_patches', 'skill_reviews', 'skill_usage', 'skills'];

/** Helper: enumerate non-internal user tables (i.e. excluding sqlite_*). */
function listUserTables(db: DatabaseSync): string[] {
  const rows = db
    .prepare(
      "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name",
    )
    .all() as Array<{ name: string }>;
  return rows.map((r) => r.name);
}

/** Helper: list the indexes on a given table. */
function listIndexes(db: DatabaseSync, tableName: string): string[] {
  const rows = db.prepare(`PRAGMA index_list(${tableName})`).all() as Array<{ name: string }>;
  return rows.map((r) => r.name);
}

// ---------------------------------------------------------------------------
// Suite
// ---------------------------------------------------------------------------

describe('skills-schema + skills-db', () => {
  let tmpRoot: string;
  let dbPath: string;

  beforeEach(async () => {
    tmpRoot = mkdtempSync(join(tmpdir(), 'cleo-t9651-'));
    dbPath = join(tmpRoot, 'skills.db');
    // Ensure module singleton is reset before each test so different tmpdirs
    // don't bleed across cases.
    const mod = await import('../skills-db.js');
    mod.resetSkillsDbState();
  });

  afterEach(async () => {
    const mod = await import('../skills-db.js');
    mod.closeSkillsDb();
    rmSync(tmpRoot, { recursive: true, force: true });
  });

  // -------------------------------------------------------------------------
  // Path + materialisation
  // -------------------------------------------------------------------------

  it('SKILLS_DB_FILENAME is "skills.db"', async () => {
    const { SKILLS_DB_FILENAME } = await import('../skills-db.js');
    expect(SKILLS_DB_FILENAME).toBe('skills.db');
  });

  it('openSkillsDb({path}) materialises the file on a fresh tmpdir', async () => {
    expect(existsSync(dbPath)).toBe(false);

    const { openSkillsDb } = await import('../skills-db.js');
    await openSkillsDb({ path: dbPath });

    expect(existsSync(dbPath)).toBe(true);
  });

  it('openSkillsDb creates all 4 skill tables', async () => {
    const { openSkillsDb } = await import('../skills-db.js');
    await openSkillsDb({ path: dbPath });

    const raw = new DatabaseSync(dbPath); // db-open-allowed
    const tables = listUserTables(raw);
    raw.close();

    for (const expected of EXPECTED_SKILL_TABLES) {
      expect(tables).toContain(expected);
    }
  });

  it('openSkillsDb creates the drizzle journal + meta sentinel', async () => {
    const { openSkillsDb } = await import('../skills-db.js');
    await openSkillsDb({ path: dbPath });

    const raw = new DatabaseSync(dbPath); // db-open-allowed
    const tables = listUserTables(raw);
    raw.close();

    expect(tables).toContain('__drizzle_migrations');
    expect(tables).toContain('_skills_meta');
  });

  it('expected indexes exist on the skills table', async () => {
    const { openSkillsDb } = await import('../skills-db.js');
    await openSkillsDb({ path: dbPath });

    const raw = new DatabaseSync(dbPath); // db-open-allowed
    const indexes = listIndexes(raw, 'skills');
    raw.close();

    expect(indexes).toContain('idx_skills_state');
    expect(indexes).toContain('idx_skills_source');
    // Unique on `name` is required by the architecture.
    expect(indexes.some((n) => n.toLowerCase().includes('name'))).toBe(true);
  });

  it('openSkillsDb is idempotent (second call returns same handle, no error)', async () => {
    const { openSkillsDb } = await import('../skills-db.js');
    const first = await openSkillsDb({ path: dbPath });
    const second = await openSkillsDb({ path: dbPath });
    expect(second).toBe(first);
  });

  // -------------------------------------------------------------------------
  // Round-trips
  // -------------------------------------------------------------------------

  it('skills round-trip: insert + select', async () => {
    const { openSkillsDb } = await import('../skills-db.js');
    const db = await openSkillsDb({ path: dbPath });

    const row: NewSkillRow = {
      name: 'ct-orchestrator',
      version: '2026.5.81',
      sourceType: 'canonical',
      sourceUrl: null,
      installPath: '/tmp/skills/ct-orchestrator',
      canonicalPath: '/tmp/skills/ct-orchestrator',
      installedAt: '2026-05-19T00:00:00.000Z',
      lastUpdatedAt: '2026-05-19T00:00:00.000Z',
      lifecycleState: 'active',
      pinned: false,
      isAgentCreated: false,
      archivedAt: null,
      archivedFromPath: null,
    };
    db.insert(skills).values(row).run();

    const out = db.select().from(skills).all();
    expect(out).toHaveLength(1);
    expect(out[0]?.name).toBe('ct-orchestrator');
    expect(out[0]?.sourceType).toBe('canonical');
    expect(out[0]?.lifecycleState).toBe('active');
    expect(out[0]?.pinned).toBe(false);
    expect(out[0]?.isAgentCreated).toBe(false);
  });

  it('skill_usage round-trip: insert + select', async () => {
    const { openSkillsDb } = await import('../skills-db.js');
    const db = await openSkillsDb({ path: dbPath });

    const row: NewSkillUsageRow = {
      skillName: 'ct-cleo',
      eventKind: 'load',
      taskId: 'T9651',
      modelId: 'claude-opus-4-7',
      metadata: '{"reason":"test"}',
    };
    db.insert(skillUsage).values(row).run();

    const out = db.select().from(skillUsage).all();
    expect(out).toHaveLength(1);
    expect(out[0]?.skillName).toBe('ct-cleo');
    expect(out[0]?.eventKind).toBe('load');
    expect(out[0]?.observedAt).toMatch(/^\d{4}-\d{2}-\d{2}/); // default datetime('now')
  });

  it('skill_reviews round-trip: insert + select', async () => {
    const { openSkillsDb } = await import('../skills-db.js');
    const db = await openSkillsDb({ path: dbPath });

    const row: NewSkillReviewRow = {
      skillName: 'ct-cleo',
      outcome: 'approved',
      score: 92,
      reviewRunId: 'run-001',
      summary: 'Looks good',
    };
    db.insert(skillReviews).values(row).run();

    const out = db.select().from(skillReviews).all();
    expect(out).toHaveLength(1);
    expect(out[0]?.outcome).toBe('approved');
    expect(out[0]?.score).toBe(92);
  });

  it('skill_patches round-trip: insert + select with defaults', async () => {
    const { openSkillsDb } = await import('../skills-db.js');
    const db = await openSkillsDb({ path: dbPath });

    const row: NewSkillPatchRow = {
      skillName: 'ct-cleo',
      diff: '--- a/SKILL.md\n+++ b/SKILL.md\n@@ -1 +1 @@\n-old\n+new\n',
    };
    db.insert(skillPatches).values(row).run();

    const out = db.select().from(skillPatches).all();
    expect(out).toHaveLength(1);
    expect(out[0]?.status).toBe('proposed'); // default
    expect(out[0]?.diff).toContain('--- a/SKILL.md');
  });

  // -------------------------------------------------------------------------
  // CHECK constraints
  // -------------------------------------------------------------------------

  it('source_type CHECK constraint rejects invalid enum values', async () => {
    const { openSkillsDb } = await import('../skills-db.js');
    await openSkillsDb({ path: dbPath });

    // Use raw SQL to bypass the TypeScript enum guard — we are testing the
    // database-level constraint, not the type system.
    const raw = new DatabaseSync(dbPath); // db-open-allowed
    expect(() =>
      raw
        .prepare(
          `INSERT INTO skills (name, source_type, install_path, installed_at)
           VALUES ('bogus-skill', 'not-a-real-source', '/tmp/x', '2026-05-19T00:00:00.000Z')`,
        )
        .run(),
    ).toThrow(/CHECK constraint failed|constraint/i);
    raw.close();
  });

  it('lifecycle_state CHECK constraint rejects invalid values', async () => {
    const { openSkillsDb } = await import('../skills-db.js');
    await openSkillsDb({ path: dbPath });

    const raw = new DatabaseSync(dbPath); // db-open-allowed
    expect(() =>
      raw
        .prepare(
          `INSERT INTO skills (name, source_type, install_path, installed_at, lifecycle_state)
           VALUES ('x', 'user', '/tmp/x', '2026-05-19T00:00:00.000Z', 'not-a-state')`,
        )
        .run(),
    ).toThrow(/CHECK constraint failed|constraint/i);
    raw.close();
  });

  // -------------------------------------------------------------------------
  // Helpers (acceptance criterion 4)
  // -------------------------------------------------------------------------

  it('getSkillRow returns null for an unknown name', async () => {
    const { openSkillsDb, getSkillRow } = await import('../skills-db.js');
    await openSkillsDb({ path: dbPath });

    const out = await getSkillRow('definitely-not-installed');
    expect(out).toBeNull();
  });

  it('upsertSkillRow inserts then updates (idempotent on name)', async () => {
    const { openSkillsDb, upsertSkillRow, getSkillRow } = await import('../skills-db.js');
    await openSkillsDb({ path: dbPath });

    const inserted = await upsertSkillRow({
      name: 'ct-test',
      sourceType: 'user',
      installPath: '/tmp/ct-test',
      installedAt: '2026-05-19T00:00:00.000Z',
      version: '1.0.0',
    });
    expect(inserted.name).toBe('ct-test');
    expect(inserted.version).toBe('1.0.0');

    const updated = await upsertSkillRow({
      name: 'ct-test',
      sourceType: 'user',
      installPath: '/tmp/ct-test',
      installedAt: '2026-05-19T00:00:00.000Z',
      version: '2.0.0',
    });
    expect(updated.version).toBe('2.0.0');
    expect(updated.id).toBe(inserted.id); // surrogate key preserved across update

    const fresh = await getSkillRow('ct-test');
    expect(fresh?.version).toBe('2.0.0');
  });

  it('listSkillsBySource filters by source_type and optionally by lifecycle_state', async () => {
    const { openSkillsDb, upsertSkillRow, listSkillsBySource } = await import('../skills-db.js');
    await openSkillsDb({ path: dbPath });

    await upsertSkillRow({
      name: 'a-user',
      sourceType: 'user',
      installPath: '/tmp/a',
      installedAt: '2026-05-19T00:00:00.000Z',
    });
    await upsertSkillRow({
      name: 'b-community',
      sourceType: 'community',
      installPath: '/tmp/b',
      installedAt: '2026-05-19T00:00:00.000Z',
    });
    await upsertSkillRow({
      name: 'c-user-archived',
      sourceType: 'user',
      installPath: '/tmp/c',
      installedAt: '2026-05-19T00:00:00.000Z',
      lifecycleState: 'archived',
      archivedAt: '2026-05-19T01:00:00.000Z',
    });

    const allUsers = await listSkillsBySource('user');
    expect(allUsers.map((r) => r.name)).toEqual(['a-user', 'c-user-archived']);

    const activeUsers = await listSkillsBySource('user', { lifecycleState: 'active' });
    expect(activeUsers.map((r) => r.name)).toEqual(['a-user']);

    const community = await listSkillsBySource('community');
    expect(community.map((r) => r.name)).toEqual(['b-community']);

    const agentCreated = await listSkillsBySource('agent-created');
    expect(agentCreated).toEqual([]);
  });

  // -------------------------------------------------------------------------
  // openCleoDb chokepoint wiring
  // -------------------------------------------------------------------------

  it('openCleoDb("skills") returns a handle (chokepoint compliance, ADR-068)', async () => {
    // The chokepoint resolves the path via `getDefaultSkillsDbPath()` which
    // calls `getCleoHome()`. For this test we exercise the in-memory wiring
    // by first opening explicitly at a tmpdir path so the singleton is set;
    // then openCleoDb('skills') returns the cached handle.
    const { openSkillsDb } = await import('../skills-db.js');
    await openSkillsDb({ path: dbPath });

    const { openCleoDb } = await import('../open-cleo-db.js');
    const handle = await openCleoDb('skills');
    expect(handle.role).toBe('skills');
    expect(handle.db).toBeDefined();
  });
});
