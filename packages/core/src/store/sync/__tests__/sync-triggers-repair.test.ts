/**
 * `cleo doctor sync-triggers`: triggers that reference missing objects, and
 * the on-demand `--repair` (journal spec §2.3a rule 9; T12754).
 *
 * Every store is a temp project `cleo.db` opened through the chokepoint.
 *
 * @task T12754
 */

import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  danglingTriggers,
  inspectSyncTriggers,
  repairSyncTriggers,
  syncTriggersDoctorCheck,
} from '../../../doctor/sync-triggers.js';
import { _resetDualScopeDbCache, openDualScopeDbAtPath } from '../../dual-scope-db.js';
import { setCaptureEnabled } from '../capture.js';

const SYNC_SCHEMA = resolve(import.meta.dirname, '../../../../migrations/sync-journal');

let dir: string;
let dbPath: string;
const projectRoot = () => join(dir, 'project');

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'cleo-sync-triggers-repair-'));
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

async function openStore(capture = false): Promise<DatabaseSync> {
  const handle = await openDualScopeDbAtPath('project', dbPath);
  const db = handle.db.$client as DatabaseSync;
  if (capture) setCaptureEnabled(db, 'project', true, { schemaRoot: SYNC_SCHEMA });
  return db;
}

const triggerExists = (db: DatabaseSync, name: string) =>
  db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'trigger' AND name = ?").get(name) !==
  undefined;

describe('triggers that reference missing objects (T12754)', () => {
  it('a migrated store, with capture on, has none: no false positive from FTS, CTEs or functions', async () => {
    const db = await openStore(true);
    expect(danglingTriggers(db)).toEqual([]);
    expect(syncTriggersDoctorCheck(projectRoot()).status).toBe('ok');
  });

  it('an FTS5 delete leg (command column, rowid) is not a missing column', async () => {
    const db = await openStore();
    db.exec(`
      CREATE VIRTUAL TABLE t12754_fts USING fts5(body);
      CREATE TABLE t12754_doc (id INTEGER PRIMARY KEY, body TEXT);
      CREATE TRIGGER t12754_doc_ad AFTER DELETE ON t12754_doc BEGIN
        INSERT INTO t12754_fts (t12754_fts, rowid, body) VALUES ('delete', OLD.id, OLD.body);
      END;
    `);
    expect(danglingTriggers(db)).toEqual([]);
  });

  it('finds a trigger writing to a missing table or a missing column, and reports an error', async () => {
    const db = await openStore();
    db.exec(`
      CREATE TABLE t12754_side (id TEXT);
      CREATE TRIGGER t12754_writes_gone AFTER INSERT ON tasks_sessions
      BEGIN INSERT INTO t12754_side (id) VALUES (NEW.id); END;
      CREATE TRIGGER t12754_bad_column AFTER INSERT ON tasks_sessions
      BEGIN INSERT INTO t12754_side (id, nope) VALUES (NEW.id, 1); END;
      CREATE TRIGGER t12754_reads_gone AFTER INSERT ON tasks_sessions
      BEGIN SELECT count(*) FROM t12754_side; END;
    `);
    expect(danglingTriggers(db)).toEqual([
      { name: 't12754_bad_column', missing: ['column t12754_side.nope'] },
    ]);
    db.exec('DROP TABLE t12754_side');
    expect(danglingTriggers(db)).toEqual([
      { name: 't12754_bad_column', missing: ['table t12754_side'] },
      { name: 't12754_reads_gone', missing: ['table t12754_side'] },
      { name: 't12754_writes_gone', missing: ['table t12754_side'] },
    ]);
    const row = syncTriggersDoctorCheck(projectRoot());
    expect(row.status).toBe('error');
    expect(row.message).toMatch(/referencing missing objects/);
    expect(row.message).toContain('t12754_writes_gone (table t12754_side)');
  });
});

describe('cleo doctor sync-triggers --repair (T12754)', () => {
  it('heals a missing _sync_capture: the capture triggers no longer dangle', async () => {
    const db = await openStore(true);
    db.exec('DROP TABLE _sync_capture');
    const broken = inspectSyncTriggers(projectRoot());
    expect(broken.orphanedCaptureTriggers.length).toBeGreaterThan(0);
    expect(broken.dangling.some((d) => d.missing.includes('table _sync_capture'))).toBe(true);

    const result = await repairSyncTriggers(projectRoot());
    expect(result.before.status).toBe('error');
    expect(result.after.status).toBe('ok');
    expect(result.actions).toContain('recreated _sync_capture');
    expect(inspectSyncTriggers(projectRoot()).dangling).toEqual([]);
  });

  it('re-runs the owned DDL of a missing guard trigger and recreates cleo_trigger_suspend', async () => {
    const db = await openStore();
    db.exec('DROP TRIGGER tasks_sessions_release_claims_on_delete');
    db.exec('DROP TABLE cleo_trigger_suspend');
    const result = await repairSyncTriggers(projectRoot());
    expect(result.before.status).toBe('error');
    expect(result.actions).toContain('recreated cleo_trigger_suspend');
    expect(result.actions).toContain(
      're-ran the owned DDL of tasks_sessions_release_claims_on_delete (missing)',
    );
    expect(triggerExists(db, 'tasks_sessions_release_claims_on_delete')).toBe(true);
    expect(result.after.status).toBe('ok');
  });

  it('never drops a trigger CLEO does not own; it stays in the report', async () => {
    const db = await openStore();
    db.exec(`
      CREATE TABLE t12754_side (id TEXT);
      CREATE TRIGGER t12754_foreign AFTER INSERT ON tasks_sessions
      BEGIN INSERT INTO t12754_side (id) VALUES (NEW.id); END;
      DROP TABLE t12754_side;
    `);
    const result = await repairSyncTriggers(projectRoot());
    expect(triggerExists(db, 't12754_foreign')).toBe(true);
    expect(result.after.status).toBe('error');
    expect(result.after.message).toContain('t12754_foreign (table t12754_side)');
  });

  it('a healthy store: nothing to do', async () => {
    await openStore(true);
    const result = await repairSyncTriggers(projectRoot());
    expect(result.actions).toEqual([]);
    expect(result.after.status).toBe('ok');
  });
});
