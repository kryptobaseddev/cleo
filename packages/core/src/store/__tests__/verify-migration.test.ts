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

// ---------------------------------------------------------------------------
// T11577 — global-scope cutover: generalised internal-ledger skip + surplus.
// The 3 real-data dry-run blockers: _signaldock_migrations (2→0),
// _skills_meta (1→0), nexus_audit_log surplus (161923→161926).
// ---------------------------------------------------------------------------

describe('verifyMigration — generalised internal-ledger skip (T11577)', () => {
  it('isDerivedOrInternalTable classifies signaldock/skills ledgers + any _<domain>_(meta|migrations)', () => {
    // Exact known ledgers (the 3 real-data blockers' class).
    expect(isDerivedOrInternalTable('_signaldock_meta')).toBe(true);
    expect(isDerivedOrInternalTable('_signaldock_migrations')).toBe(true);
    expect(isDerivedOrInternalTable('_skills_meta')).toBe(true);
    // Pre-existing conduit ledgers still excluded (no regression).
    expect(isDerivedOrInternalTable('_conduit_meta')).toBe(true);
    expect(isDerivedOrInternalTable('_conduit_migrations')).toBe(true);
    // Future-proof PATTERN: any _<domain>_meta / _<domain>_migrations ledger.
    expect(isDerivedOrInternalTable('_brain_migrations')).toBe(true);
    expect(isDerivedOrInternalTable('_tasks2_meta')).toBe(true);
    expect(isDerivedOrInternalTable('_nexus_migrations')).toBe(true);
    // Must NOT catch real data tables — including ones that merely END in
    // a similar word but are not underscore-prefixed ledgers.
    expect(isDerivedOrInternalTable('signaldock_skills')).toBe(false);
    expect(isDerivedOrInternalTable('skills_skills')).toBe(false);
    expect(isDerivedOrInternalTable('schema_meta')).toBe(false); // no leading underscore
    expect(isDerivedOrInternalTable('brain_schema_meta')).toBe(false); // not _<domain>_meta shape
    expect(isDerivedOrInternalTable('migrations')).toBe(false); // no _<domain>_ prefix
    expect(isDerivedOrInternalTable('_metadata')).toBe(false); // not the _<domain>_meta shape
  });

  it('GREEN: signaldock source with _signaldock_meta/_migrations + _skills_meta verifies ok (no N→0 deficit)', () => {
    const tmpDir = makeTempDir();
    const sourcePath = join(tmpDir, 'signaldock.db');
    const skillsPath = join(tmpDir, 'skills.db');
    const projectPath = join(tmpDir, 'cleo-project.db');
    const globalPath = join(tmpDir, 'cleo-global.db');
    try {
      // signaldock.db: a real base table (skills, 36 rows → agent_registry_skills)
      // PLUS the private ledger tables the real-data dry-run aborted on.
      const sd = new DatabaseSync(sourcePath);
      try {
        sd.exec(`CREATE TABLE "skills" (id INTEGER PRIMARY KEY, slug TEXT)`);
        for (let i = 1; i <= 36; i++) sd.exec(`INSERT INTO "skills" VALUES (${i}, 's-${i}')`);
        sd.exec(`CREATE TABLE "_signaldock_meta" (key TEXT PRIMARY KEY, value TEXT)`);
        sd.exec(`INSERT INTO "_signaldock_meta" VALUES ('schema_version', '3')`);
        sd.exec(
          `CREATE TABLE "_signaldock_migrations" (id INTEGER PRIMARY KEY, name TEXT, applied_at INTEGER)`,
        );
        sd.exec(`INSERT INTO "_signaldock_migrations" VALUES (1, 'init', 0)`);
        sd.exec(`INSERT INTO "_signaldock_migrations" VALUES (2, 'add-skills', 1)`); // the 2→0 blocker
      } finally {
        sd.close();
      }

      // skills.db: a real base table (skills, 12 rows → skills_skills) + its
      // _skills_meta ledger (the 1→0 blocker).
      const sk = new DatabaseSync(skillsPath);
      try {
        sk.exec(`CREATE TABLE "skills" (id INTEGER PRIMARY KEY, name TEXT)`);
        for (let i = 1; i <= 12; i++) sk.exec(`INSERT INTO "skills" VALUES (${i}, 'k-${i}')`);
        sk.exec(`CREATE TABLE "_skills_meta" (key TEXT PRIMARY KEY, value TEXT)`);
        sk.exec(`INSERT INTO "_skills_meta" VALUES ('schema_version', '1')`); // the 1→0 blocker
      } finally {
        sk.close();
      }

      // Consolidated GLOBAL target: the two base tables fully copied; the ledger
      // tables have NO consolidated home (recreated by runtime).
      const g = new DatabaseSync(globalPath);
      try {
        g.exec(`CREATE TABLE "agent_registry_skills" (id INTEGER PRIMARY KEY, slug TEXT)`);
        for (let i = 1; i <= 36; i++)
          g.exec(`INSERT INTO "agent_registry_skills" VALUES (${i}, 's-${i}')`);
        g.exec(`CREATE TABLE "skills_skills" (id INTEGER PRIMARY KEY, name TEXT)`);
        for (let i = 1; i <= 12; i++) g.exec(`INSERT INTO "skills_skills" VALUES (${i}, 'k-${i}')`);
      } finally {
        g.close();
      }
      new DatabaseSync(projectPath).close();

      const sources: LegacyDbDescriptor[] = [
        { name: 'signaldock', path: sourcePath, targetScope: 'global' },
        { name: 'skills', path: skillsPath, targetScope: 'global' },
      ];
      const r = verifyMigration(sources, projectPath, globalPath);

      // GREEN: base tables verified, ledger tables SKIPPED — no N→0 deficit.
      expect(r.ok, r.error ?? '').toBe(true);
      // The ledger tables must NOT appear as parity rows.
      expect(r.tables.some((t) => t.targetTable.startsWith('_'))).toBe(false);
      // The base tables ARE verified at full parity.
      expect(r.tables.find((t) => t.targetTable === 'agent_registry_skills')?.countMatch).toBe(
        true,
      );
      expect(r.tables.find((t) => t.targetTable === 'skills_skills')?.countMatch).toBe(true);
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});

describe('verifyMigration — row SURPLUS is tolerated, DEFICIT still fails (T11577)', () => {
  let tmpDir: string;
  let sourcePath: string;
  let projectPath: string;
  let globalPath: string;

  beforeEach(() => {
    tmpDir = makeTempDir();
    sourcePath = join(tmpDir, 'nexus.db');
    projectPath = join(tmpDir, 'cleo-project.db');
    globalPath = join(tmpDir, 'cleo-global.db');
    new DatabaseSync(globalPath).close();

    // Source: nexus_audit_log with 100 rows (stands in for the legacy audit log).
    const src = new DatabaseSync(sourcePath);
    try {
      src.exec(`CREATE TABLE "nexus_audit_log" (id INTEGER PRIMARY KEY, action TEXT)`);
      for (let i = 1; i <= 100; i++)
        src.exec(`INSERT INTO "nexus_audit_log" VALUES (${i}, 'a-${i}')`);
    } finally {
      src.close();
    }
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  function sources(): LegacyDbDescriptor[] {
    // nexus_audit_log lands in PROJECT scope (ADR-090 nexus residency).
    return [{ name: 'nexus', path: sourcePath, targetScope: 'project' }];
  }

  it('GREEN: a target SURPLUS (more rows than source, e.g. migration-time audit writes) does NOT fail', () => {
    // Target has 103 rows — the original 100 PLUS 3 rows the migration itself
    // wrote during the migrating open (nexus/registry.ts writeNexusAudit). This
    // is the exact 161923→161926 blocker shape. NOT data loss.
    const tgt = new DatabaseSync(projectPath);
    try {
      tgt.exec(`CREATE TABLE "nexus_audit_log" (id INTEGER PRIMARY KEY, action TEXT)`);
      for (let i = 1; i <= 103; i++)
        tgt.exec(`INSERT INTO "nexus_audit_log" VALUES (${i}, 'a-${i}')`);
    } finally {
      tgt.close();
    }

    const r = verifyMigration(sources(), projectPath, globalPath);

    // The gate is GREEN: a surplus is never loss.
    expect(r.ok, r.error ?? '').toBe(true);
    expect(r.error).toBeUndefined();
    const entry = r.tables.find((t) => t.targetTable === 'nexus_audit_log');
    expect(entry?.sourceCount).toBe(100);
    expect(entry?.targetCount).toBe(103);
    // The per-table countMatch field stays a STRICT diagnostic (100 !== 103) so
    // the surplus remains visible to an operator inspecting the report.
    expect(entry?.countMatch).toBe(false);
  });

  it('STILL FAILS: a genuine DEFICIT (target < source) aborts — surplus tolerance does NOT mask loss', () => {
    // Target has only 97 rows — 3 are MISSING. This is real data loss.
    const tgt = new DatabaseSync(projectPath);
    try {
      tgt.exec(`CREATE TABLE "nexus_audit_log" (id INTEGER PRIMARY KEY, action TEXT)`);
      for (let i = 1; i <= 97; i++)
        tgt.exec(`INSERT INTO "nexus_audit_log" VALUES (${i}, 'a-${i}')`);
    } finally {
      tgt.close();
    }

    const r = verifyMigration(sources(), projectPath, globalPath);

    // Deficit → FAIL. The error names the table and reports the missing rows.
    expect(r.ok).toBe(false);
    expect(r.error).toBeDefined();
    expect(r.error).toContain('nexus_audit_log');
    expect(r.error).toMatch(/DEFICIT|missing/i);
    const entry = r.tables.find((t) => t.targetTable === 'nexus_audit_log');
    expect(entry?.sourceCount).toBe(100);
    expect(entry?.targetCount).toBe(97);
  });
});

// ---------------------------------------------------------------------------
// T11834 — the content digest is STREAMED (statement iterator), NOT `.all()`-
// materialised. A large table must verify with the SAME correctness as before
// without pulling the whole table into a JS array (the OOM that rolled back a
// lossless cutover on a 697K-row / 1.7 GB-class brain.db). count comes from a
// set-based COUNT(*) so the parity gate never depends on the heavy digest.
// ---------------------------------------------------------------------------

describe('verifyMigration — streamed content digest at scale (T11834)', () => {
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

  const N = 5000;

  function seed(path: string, mutateAt?: number): void {
    const db = new DatabaseSync(path);
    try {
      db.exec(
        `CREATE TABLE "brain_weight_history" (id INTEGER PRIMARY KEY, weight REAL, note TEXT)`,
      );
      const ins = db.prepare(`INSERT INTO "brain_weight_history" VALUES (?, ?, ?)`);
      db.exec('BEGIN');
      for (let i = 1; i <= N; i++) {
        ins.run(i, i * 0.5, i === mutateAt ? 'CORRUPTED' : `n-${i}`);
      }
      db.exec('COMMIT');
    } finally {
      db.close();
    }
  }

  function sources(): LegacyDbDescriptor[] {
    return [{ name: 'brain (project)', path: sourcePath, targetScope: 'project' }];
  }

  it('GREEN: a 5000-row table copied faithfully verifies ok via the streamed digest', () => {
    seed(sourcePath);
    seed(projectPath);

    const r = verifyMigration(sources(), projectPath, globalPath);
    expect(r.ok, r.error ?? '').toBe(true);
    const entry = r.tables.find((t) => t.targetTable === 'brain_weight_history');
    expect(entry?.sourceCount).toBe(N);
    expect(entry?.targetCount).toBe(N);
    expect(entry?.countMatch).toBe(true);
    expect(entry?.hashMatch).toBe(true);
  });

  it('detects a single corrupted row among 5000 (streamed hashMatch=false, counts still match)', () => {
    seed(sourcePath);
    seed(projectPath, 2500); // one row differs

    const r = verifyMigration(sources(), projectPath, globalPath);
    const entry = r.tables.find((t) => t.targetTable === 'brain_weight_history');
    expect(entry?.countMatch).toBe(true);
    expect(entry?.hashMatch).toBe(false);
  });
});
