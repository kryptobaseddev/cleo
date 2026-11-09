/**
 * Sync compatibility of the retired `tasks_tasks.ivtr_state` column (T14311).
 *
 * A receiver refuses an op that names a column its schema lacks
 * (`refused-schema`, held and retried, never partly applied: merge engine
 * `applyOp`, pinned by merge-engine.test "an op naming a column this schema
 * lacks"). So the column must never reach a payload. These tests pin why it
 * does not:
 * - on a store still shaped like an older build (column present, capture on),
 *   an insert's image leaves NULL members out and an update's image carries
 *   only the columns it changed, so a row whose `ivtr_state` is NULL or
 *   unchanged never carries it (no build writes the column since T11896);
 * - when that store runs the retire migration, the runner regenerates the
 *   capture triggers from the new schema, so none references the column, and
 *   the migration's own writes are not captured.
 *
 * @task T14311
 */

import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { _resetDualScopeDbCache, openDualScopeDbAtPath } from '../../dual-scope-db.js';
import { generateCaptureTriggers, installCaptureTriggers, setCaptureEnabled } from '../capture.js';

const SYNC_SCHEMA = resolve(import.meta.dirname, '../../../../migrations/sync-journal');

let dir: string;
let dbPath: string;

async function openStore(): Promise<DatabaseSync> {
  const handle = await openDualScopeDbAtPath('project', dbPath);
  return handle.db.$client as DatabaseSync;
}

/** SQL of every trigger on `tasks_tasks` that mentions `ivtr_state`. */
function triggersNamingColumn(db: DatabaseSync): string[] {
  return (
    db
      .prepare(
        "SELECT name FROM sqlite_master WHERE type = 'trigger' AND tbl_name = 'tasks_tasks' AND sql LIKE '%ivtr_state%'",
      )
      .all() as Array<{ name: string }>
  ).map((r) => r.name);
}

/** Parsed capture images of `tasks_tasks`, oldest first. */
function images(db: DatabaseSync): Array<{ op: string; img: Record<string, unknown> }> {
  return (
    db
      .prepare("SELECT op, img FROM _sync_capture WHERE tbl = 'tasks_tasks' ORDER BY seq")
      .all() as Array<{ op: string; img: string }>
  ).map((r) => ({ op: r.op, img: JSON.parse(r.img) as Record<string, unknown> }));
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'cleo-t14311-sync-'));
  mkdirSync(join(dir, 'project', '.cleo'), { recursive: true });
  mkdirSync(join(dir, 'cleo'), { recursive: true });
  vi.stubEnv('CLEO_HOME', join(dir, 'cleo'));
  vi.stubEnv('CLEO_ROOT', undefined);
  vi.stubEnv('CLEO_DIR', undefined);
  dbPath = join(dir, 'project', '.cleo', 'cleo.db');
});

afterEach(() => {
  _resetDualScopeDbCache();
  vi.unstubAllEnvs();
  rmSync(dir, { recursive: true, force: true });
});

describe('retired ivtr_state and the change journal (T14311)', () => {
  it('a store at head has no capture trigger naming the column, and generates none', async () => {
    const db = await openStore();
    setCaptureEnabled(db, 'project', true, { schemaRoot: SYNC_SCHEMA });
    expect(triggersNamingColumn(db)).toEqual([]);
    const generated = generateCaptureTriggers(db, 'project').map((t) => t.sql);
    expect(generated.length).toBeGreaterThan(0);
    expect(generated.filter((sql) => sql.includes('ivtr_state'))).toEqual([]);
  });

  it('an older-shaped store never captures the column, and the migration regenerates its triggers without it', async () => {
    const db = await openStore();
    setCaptureEnabled(db, 'project', true, { schemaRoot: SYNC_SCHEMA });
    // Rewind to an older build's shape: the column exists, one row carries
    // legacy state, the retire migration has not run.
    db.exec('ALTER TABLE tasks_tasks ADD COLUMN ivtr_state TEXT');
    db.exec(
      "INSERT INTO tasks_tasks (id, title, type, status, ivtr_state) VALUES ('T0', 'legacy', 'task', 'pending', '{\"currentPhase\":\"implement\"}')",
    );
    db.prepare(
      "DELETE FROM __drizzle_migrations WHERE name LIKE '%t14311-retire-ivtr-state'",
    ).run();
    db.exec('DELETE FROM _sync_capture');
    installCaptureTriggers(db, 'project');
    // Positive control: the regenerated triggers do see the column now.
    expect(triggersNamingColumn(db).length).toBeGreaterThan(0);

    // What an older build writes: a new task (ivtr_state NULL) and an edit.
    db.exec(
      "INSERT INTO tasks_tasks (id, title, type, status) VALUES ('T1', 'new', 'task', 'pending')",
    );
    db.exec("UPDATE tasks_tasks SET title = 'edited' WHERE id IN ('T0', 'T1')");
    const caps = images(db);
    expect(caps.length).toBeGreaterThanOrEqual(3);
    for (const c of caps) expect(Object.keys(c.img), c.op).not.toContain('ivtr_state');

    // The upgrade: reopening runs the retire migration inside the runner's
    // bracket, which regenerates the capture triggers for the new schema.
    db.exec('DELETE FROM _sync_capture');
    _resetDualScopeDbCache();
    const upgraded = await openStore();
    const columns = (
      upgraded.prepare('PRAGMA table_info(tasks_tasks)').all() as Array<{ name: string }>
    ).map((c) => c.name);
    expect(columns).not.toContain('ivtr_state');
    expect(triggersNamingColumn(upgraded)).toEqual([]);
    expect(
      upgraded
        .prepare(
          "SELECT count(*) AS n FROM tasks_audit_log WHERE action = 'task_ivtr_state_retired'",
        )
        .get(),
    ).toEqual({ n: 1 });
    for (const c of images(upgraded)) expect(Object.keys(c.img)).not.toContain('ivtr_state');
  });
});
