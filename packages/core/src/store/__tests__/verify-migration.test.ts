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
    expect(r.ok).toBe(false);
    expect(r.error).toContain('fk');
  });
});
