/**
 * Schema and data rewriters with capture on (journal spec §2.3a rule 11;
 * H4 T12754, B T12775): exodus reconcile, twin collapse, bundle import and
 * snapshot restore. Each must finish, keep the capture triggers, and either
 * capture its writes or mark its touch set suspect for the repair diff.
 *
 * Every store is a temp project under a `mkdtemp` directory.
 *
 * @task T12754
 */

import { copyFileSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import type { DatabaseSync as DatabaseSyncType } from 'node:sqlite';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { _resetDualScopeDbCache, openDualScopeDbAtPath } from '../../dual-scope-db.js';
import { setCaptureEnabled, syncSetTables } from '../capture.js';
import { suspectTables } from '../structural.js';
import { ensureTriggerSuspendTableAtPath } from '../trigger-suspend-at-path.js';

const _require = createRequire(import.meta.url);
const { DatabaseSync } = _require('node:sqlite') as {
  DatabaseSync: new (...args: ConstructorParameters<typeof DatabaseSyncType>) => DatabaseSyncType;
};

const SYNC_SCHEMA = resolve(import.meta.dirname, '../../../../migrations/sync-journal');

let root: string;
let cleoDir: string;
let liveDb: string;

function legacyTasksDb(dir: string): void {
  const tasks = new DatabaseSync(join(dir, 'tasks.db'));
  tasks.exec(`
    CREATE TABLE tasks (
      id TEXT PRIMARY KEY, title TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'pending',
      priority TEXT NOT NULL DEFAULT 'medium', type TEXT, parent_id TEXT REFERENCES tasks(id),
      pipeline_stage TEXT, archive_reason TEXT, created_at TEXT NOT NULL
    );
    INSERT INTO tasks VALUES
      ('T1', 'epic', 'active', 'high', 'epic', NULL, NULL, NULL, '2026-01-01T00:00:00Z'),
      ('T2', 'task', 'active', 'medium', 'task', 'T1', NULL, NULL, '2026-01-02T00:00:00Z');
  `);
  tasks.close();
}

const count = (db: DatabaseSyncType, sql: string) =>
  Number(Object.values(db.prepare(sql).get() as Record<string, unknown>)[0]);

async function captureStore(): Promise<void> {
  const h = await openDualScopeDbAtPath('project', liveDb, undefined, { dedicated: true });
  setCaptureEnabled(h.db.$client as DatabaseSyncType, 'project', true, { schemaRoot: SYNC_SCHEMA });
  h.close();
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'cleo-rewriters-capture-'));
  cleoDir = join(root, 'project', '.cleo');
  mkdirSync(cleoDir, { recursive: true });
  mkdirSync(join(root, 'cleo-home'), { recursive: true });
  vi.stubEnv('CLEO_HOME', join(root, 'cleo-home'));
  vi.stubEnv('CLEO_DIR', cleoDir);
  vi.stubEnv('CLEO_ROOT', undefined);
  liveDb = join(cleoDir, 'cleo.db');
});

afterEach(async () => {
  const { closeDb } = await import('../../sqlite.js');
  closeDb();
  _resetDualScopeDbCache();
  vi.unstubAllEnvs();
  rmSync(root, { recursive: true, force: true });
});

describe('rewriters with capture on (§2.3a rule 11)', () => {
  it('exodus reconcile copies legacy rows into a capture-enabled store; each copy is captured', async () => {
    legacyTasksDb(cleoDir);
    await captureStore();
    const { reconcileSupersededStores } = await import('../../exodus/index.js');
    const result = await reconcileSupersededStores(join(root, 'project'));
    expect(result.outcome).toBe('reconciled');
    const db = new DatabaseSync(liveDb, { readOnly: true });
    try {
      expect(count(db, 'SELECT count(*) FROM tasks_tasks')).toBe(2);
      expect(
        count(db, "SELECT count(*) FROM _sync_capture WHERE tbl = 'tasks_tasks' AND op = 'I'"),
      ).toBe(2);
      expect(
        count(
          db,
          "SELECT count(*) FROM sqlite_master WHERE name LIKE '\\_sync\\_cap\\_%' ESCAPE '\\'",
        ),
      ).toBeGreaterThan(0);
    } finally {
      db.close();
    }
  });

  it('a bundle-imported or snapshot-restored project store gets the flag table and every sync table marked suspect', async () => {
    await captureStore();
    const placed = join(root, 'placed.db');
    copyFileSync(liveDb, placed);
    const raw = new DatabaseSync(placed);
    raw.exec('DROP TABLE cleo_trigger_suspend'); // an older build's file
    raw.close();
    // The placed file came from another device or a snapshot: nothing it
    // holds was written through this device's capture.
    const step0 = ensureTriggerSuspendTableAtPath(placed);
    expect(step0?.created).toBe(true);
    const db = new DatabaseSync(placed, { readOnly: true });
    try {
      expect(suspectTables(db).sort()).toEqual(syncSetTables('project').sort());
    } finally {
      db.close();
    }
  });

  it('a placed store without the sync schema is left without it (sync off stays off)', async () => {
    const h = await openDualScopeDbAtPath('project', liveDb, undefined, { dedicated: true });
    h.close();
    const placed = join(root, 'placed.db');
    copyFileSync(liveDb, placed);
    ensureTriggerSuspendTableAtPath(placed);
    const db = new DatabaseSync(placed, { readOnly: true });
    try {
      expect(count(db, "SELECT count(*) FROM sqlite_master WHERE name = '_sync_meta'")).toBe(0);
    } finally {
      db.close();
    }
  });

  it('twin collapse runs in the bind of a capture-enabled store and leaves capture intact', async () => {
    const { getDb, getNativeDb, resetDbState } = await import('../../sqlite.js');
    const { getBrainDb } = await import('../../memory-sqlite.js');
    const { TWIN_COLLAPSE_MARKER_PREFIX } = await import('../../twin-collapse.js');
    const projectDir = join(root, 'project');
    await getDb(projectDir);
    await getBrainDb(projectDir);
    const tasks = getNativeDb(projectDir) as DatabaseSyncType;
    setCaptureEnabled(tasks, 'project', true, { schemaRoot: SYNC_SCHEMA });
    // Back to the pre-collapse shape: the counter lives in the bare table.
    const marker = `${TWIN_COLLAPSE_MARKER_PREFIX}schema_meta`;
    tasks.prepare('DELETE FROM main.tasks_schema_meta WHERE key = ?').run(marker);
    tasks
      .prepare(
        "INSERT INTO main.schema_meta (key, value) VALUES ('task_id_sequence', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
      )
      .run('{"counter":7,"lastId":"T007","checksum":"seed"}');
    resetDbState();
    _resetDualScopeDbCache();
    await getDb(projectDir); // a new process: the bind runs the collapse
    await getBrainDb(projectDir);
    const db = getNativeDb(projectDir) as DatabaseSyncType;
    expect(
      db.prepare('SELECT 1 FROM main.tasks_schema_meta WHERE key = ?').get(marker),
    ).toBeDefined();
    db.exec(
      "INSERT INTO tasks_tasks (id, title, type, status) VALUES ('T100', 'after collapse', 'task', 'pending')",
    );
    expect(
      db
        .prepare("SELECT count(*) AS n FROM _sync_capture WHERE tbl = 'tasks_tasks' AND rk = ?")
        .get(`["'T100'"]`),
    ).toEqual({ n: 1 });
  });
});
