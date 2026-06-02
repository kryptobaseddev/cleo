/**
 * Unit tests for the reusable CORE `verifyMigration()` parity primitive.
 *
 * These tests use hand-crafted fixture DBs (no mock of `openDualScopeDb`
 * required) to assert the four failure classes the primitive guards:
 *
 *   1. Per-table row-count parity (shortfall → ok:false + error).
 *   2. Content checksum (count matches but content differs → ok:false).
 *   3. `PRAGMA foreign_key_check` orphans → ok:false + foreignKeyViolations.
 *   4. Enum/type-drift report (source value outside target CHECK enum).
 *
 * The enum-drift case is the EXACT class the exodus loss (~805K rows) came
 * from — a SCHEMA-REAL CHECK constraint with a legacy value the name-matched
 * toy fixtures never carried.
 *
 * @task T11551 (DHQ-045 — exodus zero-loss durable guard)
 * @epic T10878
 * @saga T11242
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { DatabaseSync as DatabaseSyncType } from 'node:sqlite';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { isDerivedOrInternalTable } from '../exodus/table-name-map.js';
import type { LegacyDbDescriptor } from '../exodus/types.js';
import { verifyMigration } from '../exodus/verify-migration.js';

const _require = createRequire(import.meta.url);
const { DatabaseSync } = _require('node:sqlite') as {
  DatabaseSync: new (
    path: string,
    options?: { readOnly?: boolean; open?: boolean },
  ) => DatabaseSyncType;
};

vi.mock('../../logger.js', () => ({
  getLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  }),
}));

function makeTempDir(): string {
  return mkdtempSync(join(tmpdir(), 'cleo-verifymig-test-'));
}

describe('verifyMigration — row-count + content parity', () => {
  let tmpDir: string;
  let sourcePath: string;
  let projectPath: string;
  let globalPath: string;

  beforeEach(() => {
    tmpDir = makeTempDir();
    sourcePath = join(tmpDir, 'tasks.db');
    projectPath = join(tmpDir, 'cleo-project.db');
    globalPath = join(tmpDir, 'cleo-global.db');

    // Source: legacy 'tasks' table (50 rows). Maps to consolidated 'tasks_tasks'.
    const src = new DatabaseSync(sourcePath);
    try {
      src.exec(`CREATE TABLE "tasks" (id INTEGER PRIMARY KEY, val TEXT)`);
      for (let i = 1; i <= 50; i++) src.exec(`INSERT INTO "tasks" VALUES (${i}, 'v-${i}')`);
    } finally {
      src.close();
    }
    new DatabaseSync(globalPath).close();
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  function sources(): LegacyDbDescriptor[] {
    return [{ name: 'tasks', path: sourcePath, targetScope: 'project' }];
  }

  it('ok:true when every row is present (perfect migration)', () => {
    const tgt = new DatabaseSync(projectPath);
    try {
      tgt.exec(`CREATE TABLE "tasks_tasks" (id INTEGER PRIMARY KEY, val TEXT)`);
      for (let i = 1; i <= 50; i++) tgt.exec(`INSERT INTO "tasks_tasks" VALUES (${i}, 'v-${i}')`);
    } finally {
      tgt.close();
    }

    const r = verifyMigration(sources(), projectPath, globalPath);
    expect(r.ok, r.error ?? '').toBe(true);
    expect(r.error).toBeUndefined();
    expect(r.tables.find((t) => t.targetTable === 'tasks_tasks')?.countMatch).toBe(true);
    expect(r.foreignKeyViolations).toHaveLength(0);
    expect(r.enumDrift).toHaveLength(0);
  });

  it('ok:false with error naming the table on a row-count shortfall', () => {
    const tgt = new DatabaseSync(projectPath);
    try {
      tgt.exec(`CREATE TABLE "tasks_tasks" (id INTEGER PRIMARY KEY, val TEXT)`);
      for (let i = 1; i <= 40; i++) tgt.exec(`INSERT INTO "tasks_tasks" VALUES (${i}, 'v-${i}')`);
    } finally {
      tgt.close();
    }

    const r = verifyMigration(sources(), projectPath, globalPath);
    expect(r.ok).toBe(false);
    expect(r.error).toBeDefined();
    expect(r.error).toContain('tasks_tasks');
    const entry = r.tables.find((t) => t.targetTable === 'tasks_tasks');
    expect(entry?.sourceCount).toBe(50);
    expect(entry?.targetCount).toBe(40);
  });

  it('ok:false when counts match but content differs (checksum guard)', () => {
    const tgt = new DatabaseSync(projectPath);
    try {
      tgt.exec(`CREATE TABLE "tasks_tasks" (id INTEGER PRIMARY KEY, val TEXT)`);
      // 50 rows but row 1 has different content
      tgt.exec(`INSERT INTO "tasks_tasks" VALUES (1, 'CORRUPTED')`);
      for (let i = 2; i <= 50; i++) tgt.exec(`INSERT INTO "tasks_tasks" VALUES (${i}, 'v-${i}')`);
    } finally {
      tgt.close();
    }

    const r = verifyMigration(sources(), projectPath, globalPath);
    expect(r.ok).toBe(false);
    const entry = r.tables.find((t) => t.targetTable === 'tasks_tasks');
    expect(entry?.countMatch).toBe(true);
    expect(entry?.hashMatch).toBe(false);
  });
});

describe('verifyMigration — enum/type-drift report (the ~805K-row class)', () => {
  let tmpDir: string;
  let sourcePath: string;
  let projectPath: string;
  let globalPath: string;

  beforeEach(() => {
    tmpDir = makeTempDir();
    sourcePath = join(tmpDir, 'tasks.db');
    projectPath = join(tmpDir, 'cleo-project.db');
    globalPath = join(tmpDir, 'cleo-global.db');
    new DatabaseSync(globalPath).close();
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('detects a source value outside the target CHECK enum even when row counts match', () => {
    // Source: legacy 'architecture_decisions' with a NON-canonical status value
    // ('Accepted' instead of 'accepted') — the real drift the campaign found.
    const src = new DatabaseSync(sourcePath);
    try {
      src.exec(`CREATE TABLE "architecture_decisions" (id INTEGER PRIMARY KEY, status TEXT)`);
      src.exec(`INSERT INTO "architecture_decisions" VALUES (1, 'accepted')`);
      src.exec(`INSERT INTO "architecture_decisions" VALUES (2, 'Accepted')`); // drift
      src.exec(`INSERT INTO "architecture_decisions" VALUES (3, 'proposed')`);
    } finally {
      src.close();
    }

    // Target: consolidated 'tasks_architecture_decisions' with a REAL CHECK enum.
    // We deliberately seed all 3 rows (count matches) so ONLY the enum-drift
    // check can catch the un-normalised 'Accepted' value.
    const tgt = new DatabaseSync(projectPath);
    try {
      tgt.exec(
        `CREATE TABLE "tasks_architecture_decisions" (
          id INTEGER PRIMARY KEY,
          status TEXT CHECK ("status" IN ('accepted', 'proposed', 'superseded', 'deprecated'))
        )`,
      );
      tgt.exec(`INSERT INTO "tasks_architecture_decisions" VALUES (1, 'accepted')`);
      tgt.exec(`INSERT INTO "tasks_architecture_decisions" VALUES (2, 'accepted')`);
      tgt.exec(`INSERT INTO "tasks_architecture_decisions" VALUES (3, 'proposed')`);
    } finally {
      tgt.close();
    }

    const sources: LegacyDbDescriptor[] = [
      { name: 'tasks', path: sourcePath, targetScope: 'project' },
    ];
    const r = verifyMigration(sources, projectPath, globalPath);

    expect(r.ok).toBe(false);
    expect(r.enumDrift.length).toBeGreaterThan(0);
    const drift = r.enumDrift.find(
      (d) => d.targetTable === 'tasks_architecture_decisions' && d.column === 'status',
    );
    expect(drift).toBeDefined();
    expect(drift?.offendingValues).toContain('Accepted');
    expect(drift?.allowedValues).toContain('accepted');
    expect(drift?.driftCount).toBe(1);
    expect(r.error).toContain('status');
  });
});

describe('verifyMigration — PRAGMA foreign_key_check', () => {
  let tmpDir: string;
  let sourcePath: string;
  let projectPath: string;
  let globalPath: string;

  beforeEach(() => {
    tmpDir = makeTempDir();
    sourcePath = join(tmpDir, 'tasks.db');
    projectPath = join(tmpDir, 'cleo-project.db');
    globalPath = join(tmpDir, 'cleo-global.db');
    new DatabaseSync(globalPath).close();
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('reports an orphan child row as a foreign-key violation failure', () => {
    // Source has a clean parent/child pair (no orphan).
    const src = new DatabaseSync(sourcePath);
    try {
      src.exec(`CREATE TABLE "parents" (id INTEGER PRIMARY KEY)`);
      src.exec(`CREATE TABLE "children" (id INTEGER PRIMARY KEY, parent_id INTEGER)`);
      src.exec(`INSERT INTO "parents" VALUES (1)`);
      src.exec(`INSERT INTO "children" VALUES (1, 1)`);
    } finally {
      src.close();
    }

    // Target: an ORPHAN child (parent_id=99 has no parent) — simulates a
    // migration that dropped a parent row. FK constraint declared on target.
    // The orphan must be inserted with foreign_keys=OFF (the migration's own
    // FK-defer mode); PRAGMA foreign_key_check catches it afterward — exactly
    // what verifyMigration runs.
    const tgt = new DatabaseSync(projectPath);
    try {
      tgt.exec(`PRAGMA foreign_keys = OFF`);
      tgt.exec(`CREATE TABLE "parents" (id INTEGER PRIMARY KEY)`);
      tgt.exec(
        `CREATE TABLE "children" (id INTEGER PRIMARY KEY, parent_id INTEGER REFERENCES "parents"(id))`,
      );
      tgt.exec(`INSERT INTO "parents" VALUES (1)`);
      tgt.exec(`INSERT INTO "children" VALUES (1, 99)`); // orphan
    } finally {
      tgt.close();
    }

    const sources: LegacyDbDescriptor[] = [
      // Use an unrecognized source name so 'parents'/'children' map by identity.
      { name: 'fixture', path: sourcePath, targetScope: 'project' },
    ];
    const r = verifyMigration(sources, projectPath, globalPath);

    expect(r.foreignKeyViolations.length).toBeGreaterThan(0);
    expect(r.foreignKeyViolations.some((v) => v.table === 'children')).toBe(true);
    // This orphan is INTRODUCED by the migration (source had a clean pair) → fail.
    expect(r.introducedForeignKeyViolations.some((v) => v.table === 'children')).toBe(true);
    expect(r.preExistingForeignKeyViolations).toHaveLength(0);
    expect(r.ok).toBe(false);
    expect(r.error).toContain('fk');
  });
});

// ---------------------------------------------------------------------------
// BLOCKER 1 (T11572) — FTS5 + internal/meta shadow tables are NOT deficits.
// ---------------------------------------------------------------------------

describe('verifyMigration — FTS5 + internal/meta shadow-table exclusion (T11572)', () => {
  let tmpDir: string;
  let sourcePath: string;
  let projectPath: string;
  let globalPath: string;

  beforeEach(() => {
    tmpDir = makeTempDir();
    sourcePath = join(tmpDir, 'brain.db');
    projectPath = join(tmpDir, 'cleo-project.db');
    globalPath = join(tmpDir, 'cleo-global.db');
    new DatabaseSync(globalPath).close();
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('isDerivedOrInternalTable classifies FTS5 + meta tables, not base tables', () => {
    // FTS5 virtual table + its full shadow family.
    expect(isDerivedOrInternalTable('brain_decisions_fts')).toBe(true);
    expect(isDerivedOrInternalTable('brain_observations_fts')).toBe(true);
    expect(isDerivedOrInternalTable('messages_fts')).toBe(true);
    expect(isDerivedOrInternalTable('brain_decisions_fts_data')).toBe(true);
    expect(isDerivedOrInternalTable('brain_decisions_fts_idx')).toBe(true);
    expect(isDerivedOrInternalTable('brain_decisions_fts_docsize')).toBe(true);
    expect(isDerivedOrInternalTable('brain_decisions_fts_config')).toBe(true);
    expect(isDerivedOrInternalTable('messages_fts_content')).toBe(true);
    // Internal bookkeeping.
    expect(isDerivedOrInternalTable('_conduit_meta')).toBe(true);
    expect(isDerivedOrInternalTable('_conduit_migrations')).toBe(true);
    // Base data tables — must NOT be excluded.
    expect(isDerivedOrInternalTable('brain_decisions')).toBe(false);
    expect(isDerivedOrInternalTable('tasks')).toBe(false);
    expect(isDerivedOrInternalTable('conduit_messages')).toBe(false);
    // A non-FTS table that merely contains "fts" mid-name must not be caught.
    expect(isDerivedOrInternalTable('drafts')).toBe(false);
  });

  it('GREEN: a source with FTS5 shadow + _conduit_meta tables verifies ok (no N→0 deficit)', () => {
    // Source: a real base table (brain_decisions, 20 rows) PLUS an FTS5 virtual
    // table + its full shadow family + a _conduit_meta bookkeeping table — the
    // exact set the real-data dry-run aborted on.
    const src = new DatabaseSync(sourcePath);
    try {
      src.exec(
        `CREATE TABLE "brain_decisions" (id INTEGER PRIMARY KEY, decision TEXT, rationale TEXT)`,
      );
      for (let i = 1; i <= 20; i++) {
        src.exec(`INSERT INTO "brain_decisions" VALUES (${i}, 'd-${i}', 'why-${i}')`);
      }
      // Real FTS5 index over brain_decisions — this materialises
      // brain_decisions_fts + _data/_idx/_docsize/_config shadow tables, all of
      // which carry rows that do NOT correspond 1:1 to base rows.
      src.exec(
        `CREATE VIRTUAL TABLE "brain_decisions_fts" USING fts5(decision, rationale, content="brain_decisions", content_rowid="id")`,
      );
      src.exec(`INSERT INTO "brain_decisions_fts"("brain_decisions_fts") VALUES('rebuild')`);
      // Internal bookkeeping table (no consolidated home).
      src.exec(`CREATE TABLE "_conduit_meta" (key TEXT PRIMARY KEY, value TEXT)`);
      src.exec(`INSERT INTO "_conduit_meta" VALUES ('schema_version', '7')`);
    } finally {
      src.close();
    }

    // Target: ONLY the consolidated base table exists, with all 20 rows. The FTS
    // index + meta table have NO consolidated counterpart (rebuilt at runtime).
    const tgt = new DatabaseSync(projectPath);
    try {
      tgt.exec(
        `CREATE TABLE "brain_decisions" (id INTEGER PRIMARY KEY, decision TEXT, rationale TEXT)`,
      );
      for (let i = 1; i <= 20; i++) {
        tgt.exec(`INSERT INTO "brain_decisions" VALUES (${i}, 'd-${i}', 'why-${i}')`);
      }
    } finally {
      tgt.close();
    }

    const sources: LegacyDbDescriptor[] = [
      { name: 'brain (project)', path: sourcePath, targetScope: 'project' },
    ];
    const r = verifyMigration(sources, projectPath, globalPath);

    // The base table parity holds and the derived/meta tables were SKIPPED — no
    // spurious N→0 deficit, no abort.
    expect(r.ok, r.error ?? '').toBe(true);
    // The FTS/meta tables must NOT appear as a parity row (they were skipped).
    expect(r.tables.some((t) => t.targetTable.includes('_fts'))).toBe(false);
    expect(r.tables.some((t) => t.targetTable === '_conduit_meta')).toBe(false);
    // The base table IS verified.
    const base = r.tables.find((t) => t.targetTable === 'brain_decisions');
    expect(base?.countMatch).toBe(true);
    expect(base?.sourceCount).toBe(20);
  });
});

// ---------------------------------------------------------------------------
// BLOCKER 2 (T11572) — pre-existing SOURCE FK orphans are tolerated.
// ---------------------------------------------------------------------------

describe('verifyMigration — pre-existing source FK orphans tolerated (T11572)', () => {
  let tmpDir: string;
  let sourcePath: string;
  let projectPath: string;
  let globalPath: string;

  beforeEach(() => {
    tmpDir = makeTempDir();
    sourcePath = join(tmpDir, 'tasks.db');
    projectPath = join(tmpDir, 'cleo-project.db');
    globalPath = join(tmpDir, 'cleo-global.db');
    new DatabaseSync(globalPath).close();
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('GREEN: an orphan that ALREADY exists in the source migrates ok (carried forward, not a deficit)', () => {
    // Source: a parent/child pair where the child references a parent that does
    // NOT exist (parent_id=99) — a pre-existing orphan, exactly like the 2 real
    // tasks_task_relations rows pointing at deleted tasks. FK enforcement OFF so
    // the orphan can be seeded.
    const src = new DatabaseSync(sourcePath);
    try {
      src.exec(`PRAGMA foreign_keys = OFF`);
      src.exec(`CREATE TABLE "parents" (id INTEGER PRIMARY KEY)`);
      src.exec(
        `CREATE TABLE "children" (id INTEGER PRIMARY KEY, parent_id INTEGER REFERENCES "parents"(id))`,
      );
      src.exec(`INSERT INTO "parents" VALUES (1)`);
      src.exec(`INSERT INTO "children" VALUES (1, 1)`); // clean
      src.exec(`INSERT INTO "children" VALUES (2, 99)`); // PRE-EXISTING orphan
    } finally {
      src.close();
    }

    // Target: the SAME data copied faithfully — the orphan travels with the row
    // (zero loss). FK declared; orphan present on target too.
    const tgt = new DatabaseSync(projectPath);
    try {
      tgt.exec(`PRAGMA foreign_keys = OFF`);
      tgt.exec(`CREATE TABLE "parents" (id INTEGER PRIMARY KEY)`);
      tgt.exec(
        `CREATE TABLE "children" (id INTEGER PRIMARY KEY, parent_id INTEGER REFERENCES "parents"(id))`,
      );
      tgt.exec(`INSERT INTO "parents" VALUES (1)`);
      tgt.exec(`INSERT INTO "children" VALUES (1, 1)`);
      tgt.exec(`INSERT INTO "children" VALUES (2, 99)`); // same orphan carried forward
    } finally {
      tgt.close();
    }

    const sources: LegacyDbDescriptor[] = [
      { name: 'fixture', path: sourcePath, targetScope: 'project' },
    ];
    const r = verifyMigration(sources, projectPath, globalPath);

    // The orphan is detected on the target...
    expect(r.foreignKeyViolations.some((v) => v.table === 'children')).toBe(true);
    // ...but classified as PRE-EXISTING (it was in the source too) → tolerated.
    expect(r.preExistingForeignKeyViolations.some((v) => v.table === 'children')).toBe(true);
    expect(r.introducedForeignKeyViolations).toHaveLength(0);
    // Row counts match → no deficit. The migration is OK (zero loss).
    expect(r.ok, r.error ?? '').toBe(true);
  });

  it('STILL ABORTS: an orphan present ONLY on the target (source clean) is a genuine introduced loss', () => {
    // Source: a CLEAN parent/child pair (no orphan).
    const src = new DatabaseSync(sourcePath);
    try {
      src.exec(`CREATE TABLE "parents" (id INTEGER PRIMARY KEY)`);
      src.exec(`CREATE TABLE "children" (id INTEGER PRIMARY KEY, parent_id INTEGER)`);
      src.exec(`INSERT INTO "parents" VALUES (1)`);
      src.exec(`INSERT INTO "children" VALUES (1, 1)`);
    } finally {
      src.close();
    }

    // Target: an orphan the source never had (the migration dropped the parent).
    const tgt = new DatabaseSync(projectPath);
    try {
      tgt.exec(`PRAGMA foreign_keys = OFF`);
      tgt.exec(`CREATE TABLE "parents" (id INTEGER PRIMARY KEY)`);
      tgt.exec(
        `CREATE TABLE "children" (id INTEGER PRIMARY KEY, parent_id INTEGER REFERENCES "parents"(id))`,
      );
      // parent missing → introduced orphan
      tgt.exec(`INSERT INTO "children" VALUES (1, 1)`);
    } finally {
      tgt.close();
    }

    const sources: LegacyDbDescriptor[] = [
      { name: 'fixture', path: sourcePath, targetScope: 'project' },
    ];
    const r = verifyMigration(sources, projectPath, globalPath);

    expect(r.introducedForeignKeyViolations.some((v) => v.table === 'children')).toBe(true);
    expect(r.preExistingForeignKeyViolations).toHaveLength(0);
    expect(r.ok).toBe(false);
  });
});
