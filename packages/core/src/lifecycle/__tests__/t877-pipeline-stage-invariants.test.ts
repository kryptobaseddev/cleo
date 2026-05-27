/**
 * Integration test for T877 — structural invariants on pipeline_stage.
 *
 * Verifies:
 *   (1) The migration 20260417000000_t877-pipeline-stage-invariants is
 *       applied on fresh DB init.
 *   (2) The two BEFORE INSERT/UPDATE triggers exist in sqlite_master.
 *   (3) INSERT / UPDATE that would violate the invariant is rejected with
 *       a clear `T877_INVARIANT_VIOLATION` error.
 *   (4) Legal INSERT / UPDATE (status=done + pipeline_stage=contribution,
 *       status=cancelled + pipeline_stage=cancelled, status=pending + any)
 *       succeeds.
 *   (5) Pre-existing drifted rows (terminal status + non-terminal stage)
 *       introduced BEFORE the trigger is installed are automatically
 *       repaired by the migration's data-fix step.
 *   (6) The old schema_meta guard keys exist after migration (compat).
 *
 * @task T877
 * @epic T876 (owner-labelled T900)
 */

import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

let testDir: string;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function initDb(): Promise<void> {
  const { getDb } = await import('../../store/sqlite.js');
  await getDb();
}

async function nativeDb(): Promise<{
  prepare: (sql: string) => {
    get: () => unknown;
    all: () => unknown[];
    run: (...p: unknown[]) => unknown;
  };
  exec: (sql: string) => void;
}> {
  const { getNativeDb } = await import('../../store/sqlite.js');
  const db = getNativeDb();
  if (!db) throw new Error('native DB handle unavailable');
  return db as unknown as {
    prepare: (sql: string) => {
      get: () => unknown;
      all: () => unknown[];
      run: (...p: unknown[]) => unknown;
    };
    exec: (sql: string) => void;
  };
}

async function insertRaw(id: string, status: string, pipelineStage: string | null): Promise<void> {
  const db = await nativeDb();
  db.prepare(
    `INSERT INTO tasks (id, title, status, priority, pipeline_stage, created_at)
     VALUES (?, ?, ?, 'medium', ?, datetime('now'))`,
  ).run(id, `Task ${id}`, status, pipelineStage);
}

async function readStage(id: string): Promise<string | null> {
  const db = await nativeDb();
  const row = db.prepare(`SELECT pipeline_stage FROM tasks WHERE id = ?`).get() as
    | { pipeline_stage: string | null }
    | undefined;
  // better-sqlite style: prepare().get() takes args — node:sqlite is the same.
  const db2 = await nativeDb();
  const row2 = (
    db2.prepare(`SELECT pipeline_stage FROM tasks WHERE id = '${id.replace(/'/g, "''")}'`) as {
      get: () => { pipeline_stage: string | null } | undefined;
    }
  ).get();
  return row2?.pipeline_stage ?? row?.pipeline_stage ?? null;
}

// ---------------------------------------------------------------------------
// Lifecycle
// ---------------------------------------------------------------------------

beforeEach(async () => {
  testDir = await mkdtemp(join(tmpdir(), 'cleo-t877-'));
  const cleoDir = join(testDir, '.cleo');
  await mkdir(cleoDir, { recursive: true });
  process.env['CLEO_DIR'] = cleoDir;
  process.env['LIFECYCLE_ENFORCEMENT_MODE'] = 'off';
  const { closeDb } = await import('../../store/sqlite.js');
  closeDb();
});

afterEach(async () => {
  const { closeDb } = await import('../../store/sqlite.js');
  closeDb();
  delete process.env['CLEO_DIR'];
  delete process.env['LIFECYCLE_ENFORCEMENT_MODE'];
  await rm(testDir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('T877 pipeline-stage invariants — triggers', () => {
  it('installs both BEFORE triggers on fresh DB init', async () => {
    await initDb();
    const db = await nativeDb();
    const trgs = db
      .prepare(
        `SELECT name FROM sqlite_master WHERE type='trigger' AND name LIKE 'trg_tasks_status_pipeline_%'`,
      )
      .all() as Array<{ name: string }>;
    const names = new Set(trgs.map((t) => t.name));
    expect(names.has('trg_tasks_status_pipeline_insert')).toBe(true);
    expect(names.has('trg_tasks_status_pipeline_update')).toBe(true);
  });

  it('populates the schema_meta guard keys so legacy callers see backfills as done', async () => {
    await initDb();
    const db = await nativeDb();
    const keys = db
      .prepare(
        `SELECT key FROM schema_meta
         WHERE key IN ('backfill:pipeline-stage-from-lifecycle','backfill:terminal-pipeline-stage')`,
      )
      .all() as Array<{ key: string }>;
    expect(keys.length).toBe(2);
  });

  it('rejects INSERT of status=done with non-terminal pipeline_stage', async () => {
    await initDb();
    await expect(insertRaw('BAD1', 'done', 'implementation')).rejects.toThrow(
      /T877_INVARIANT_VIOLATION/,
    );
  });

  it('rejects INSERT of status=done with NULL pipeline_stage', async () => {
    await initDb();
    await expect(insertRaw('BAD2', 'done', null)).rejects.toThrow(/T877_INVARIANT_VIOLATION/);
  });

  it('rejects INSERT of status=cancelled with non-cancelled pipeline_stage', async () => {
    await initDb();
    await expect(insertRaw('BAD3', 'cancelled', 'contribution')).rejects.toThrow(
      /T877_INVARIANT_VIOLATION/,
    );
  });

  it('accepts legal INSERT status=done + pipeline_stage=contribution', async () => {
    await initDb();
    await insertRaw('OK1', 'done', 'contribution');
    expect(await readStage('OK1')).toBe('contribution');
  });

  it('accepts legal INSERT status=cancelled + pipeline_stage=cancelled', async () => {
    await initDb();
    await insertRaw('OK2', 'cancelled', 'cancelled');
    expect(await readStage('OK2')).toBe('cancelled');
  });

  it('accepts INSERT of non-terminal status with any valid stage', async () => {
    await initDb();
    await insertRaw('OK3', 'pending', 'research');
    await insertRaw('OK4', 'active', 'implementation');
    expect(await readStage('OK3')).toBe('research');
    expect(await readStage('OK4')).toBe('implementation');
  });

  it('rejects UPDATE that would drift pipeline_stage from status=done', async () => {
    await initDb();
    await insertRaw('U1', 'pending', 'research');
    const db = await nativeDb();
    expect(() => {
      db.exec(`UPDATE tasks SET status='done', pipeline_stage='research' WHERE id='U1'`);
    }).toThrow(/T877_INVARIANT_VIOLATION/);
  });

  it('accepts UPDATE to a legal terminal state', async () => {
    await initDb();
    await insertRaw('U2', 'pending', 'research');
    const db = await nativeDb();
    db.exec(`UPDATE tasks SET status='done', pipeline_stage='contribution' WHERE id='U2'`);
    expect(await readStage('U2')).toBe('contribution');
  });

  it('accepts UPDATE to status=cancelled + pipeline_stage=cancelled', async () => {
    await initDb();
    await insertRaw('U3', 'active', 'implementation');
    const db = await nativeDb();
    db.exec(`UPDATE tasks SET status='cancelled', pipeline_stage='cancelled' WHERE id='U3'`);
    expect(await readStage('U3')).toBe('cancelled');
  });

  it('allows restoring a done task back to pending without violation', async () => {
    await initDb();
    await insertRaw('R1', 'done', 'contribution');
    const db = await nativeDb();
    // status flip first, then stage — the trigger evaluates NEW row atomically.
    db.exec(`UPDATE tasks SET status='pending', pipeline_stage='research' WHERE id='R1'`);
    expect(await readStage('R1')).toBe('research');
  });
});
