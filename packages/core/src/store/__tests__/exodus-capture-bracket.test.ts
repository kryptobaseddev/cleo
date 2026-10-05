/**
 * Exodus copies a legacy store inside rule-1 brackets (journal spec §2.3a rules
 * 1 and 3; T12785 · T12774).
 *
 * The target is a real project `cleo.db` opened through the chokepoint with
 * sync capture on. The exodus copy must produce no captures (the triggers are
 * dropped inside each stage's single transaction), leave the capture triggers
 * installed and working, mark the sync set suspect so the sealer's repair diff
 * emits the copied rows, and leave foreign keys on. Temp dirs only.
 *
 * @task T12785
 * @task T12774
 */

import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { pathToFileURL } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  _resetDualScopeDbCache,
  getDualScopeNativeDb,
  openDualScopeDbAtPath,
} from '../dual-scope-db.js';
import { runExodusMigrate } from '../exodus/migrate.js';
import type { ExodusPlan } from '../exodus/types.js';
import { setCaptureEnabled } from '../sync/capture.js';
import { suspectTables } from '../sync/structural.js';

const SYNC_SCHEMA = resolve(import.meta.dirname, '../../../migrations/sync-journal');
const LEGACY_TASKS = 3;

let dir: string;
let projectDbPath: string;

const n = (db: DatabaseSync, sql: string): number => (db.prepare(sql).get() as { n: number }).n;
const captureTriggers = (db: DatabaseSync): number =>
  n(
    db,
    "SELECT count(*) AS n FROM sqlite_master WHERE type = 'trigger' AND name LIKE '_sync_cap_%'",
  );

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'cleo-exodus-capture-'));
  projectDbPath = join(dir, 'cleo.db');
  const legacy = new DatabaseSync(join(dir, 'tasks.db'));
  legacy.exec('CREATE TABLE tasks (id TEXT PRIMARY KEY, title TEXT NOT NULL)');
  for (let i = 1; i <= LEGACY_TASKS; i++) {
    legacy.exec(`INSERT INTO tasks VALUES ('T${i}', 'legacy task ${i}')`);
  }
  legacy.close();
});

afterEach(() => {
  _resetDualScopeDbCache();
  rmSync(dir, { recursive: true, force: true });
});

function plan(): ExodusPlan {
  return {
    sources: [{ name: 'tasks', path: join(dir, 'tasks.db'), targetScope: 'project' }],
    totalSourceBytes: 0,
    largestSourceBytes: 0,
    requiredBytes: 0,
    stagingCopyThresholdBytes: 256 * 1024 * 1024,
    availableBytes: 100_000_000,
    diskPreflight: true,
    stagingDir: join(dir, 'staging'),
    resumeFromStaging: false,
    projectDbPath,
    globalDbPath: join(dir, 'global.db'),
  };
}

describe('exodus copy inside rule-1 brackets (T12785 · T12774)', () => {
  it('copies without captures, keeps the triggers, marks the sync set suspect, FK back on', async () => {
    const handle = await openDualScopeDbAtPath('project', projectDbPath);
    const db = getDualScopeNativeDb(handle);
    setCaptureEnabled(db, 'project', true, { schemaRoot: SYNC_SCHEMA });
    const triggersBefore = captureTriggers(db);
    const capturesBefore = n(db, 'SELECT count(*) AS n FROM _sync_capture');
    expect(triggersBefore).toBeGreaterThan(0);

    const result = await runExodusMigrate(plan(), false, undefined, { projectOnly: true });
    expect(result.ok, result.error).toBe(true);

    expect(n(db, "SELECT count(*) AS n FROM tasks_tasks WHERE id LIKE 'T%'")).toBe(LEGACY_TASKS);
    // The copy was not captured row by row...
    expect(n(db, 'SELECT count(*) AS n FROM _sync_capture')).toBe(capturesBefore);
    // ...so the sealer must diff it: the sync set is suspect.
    expect(suspectTables(db)).toContain('tasks_tasks');
    // The triggers came back in the same transaction, and still capture.
    expect(captureTriggers(db)).toBe(triggersBefore);
    db.exec("INSERT INTO tasks_tasks (id, title) VALUES ('T99', 'after exodus')");
    expect(n(db, "SELECT count(*) AS n FROM _sync_capture WHERE tbl = 'tasks_tasks'")).toBe(1);
    expect((db.prepare('PRAGMA foreign_keys').get() as { foreign_keys: number }).foreign_keys).toBe(
      1,
    );
  });

  it('a store without capture is copied as before and nothing is marked', async () => {
    const handle = await openDualScopeDbAtPath('project', projectDbPath);
    const db = getDualScopeNativeDb(handle);
    const result = await runExodusMigrate(plan(), false, undefined, { projectOnly: true });
    expect(result.ok, result.error).toBe(true);
    expect(n(db, "SELECT count(*) AS n FROM tasks_tasks WHERE id LIKE 'T%'")).toBe(LEGACY_TASKS);
    expect(captureTriggers(db)).toBe(0);
    expect(suspectTables(db)).toEqual([]);
  });

  it('a crash between stages leaves the committed stage marked suspect (rule 3 is atomic)', async () => {
    // The built engine runs in a child that dies the moment the second source's
    // stage starts: no finally, no end-of-scope code. Whatever the first stage
    // committed must carry its own suspect mark.
    const dist = resolve(import.meta.dirname, '../../../dist/store/exodus/migrate.js');
    if (!existsSync(dist)) return; // CI builds before testing
    const handle = await openDualScopeDbAtPath('project', projectDbPath);
    const db = getDualScopeNativeDb(handle);
    setCaptureEnabled(db, 'project', true, { schemaRoot: SYNC_SCHEMA });
    const capturesBefore = n(db, 'SELECT count(*) AS n FROM _sync_capture');
    _resetDualScopeDbCache();

    const second = new DatabaseSync(join(dir, 'brain.db'));
    second.exec('CREATE TABLE brain_observations (id TEXT PRIMARY KEY, title TEXT)');
    second.close();
    const crashPlan = {
      ...plan(),
      sources: [
        { name: 'tasks', path: join(dir, 'tasks.db'), targetScope: 'project' },
        { name: 'brain', path: join(dir, 'brain.db'), targetScope: 'project' },
      ],
    };
    const script = join(dir, 'crash.mjs');
    writeFileSync(
      script,
      [
        `const { runExodusMigrate } = await import(${JSON.stringify(pathToFileURL(dist).href)});`,
        `const plan = JSON.parse(process.argv[2]);`,
        `await runExodusMigrate(plan, false, (m) => { if (m.includes('[brain] Attached')) process.exit(7); }, { projectOnly: true });`,
        `process.exit(0);`,
      ].join('\n'),
    );
    const child = spawnSync(process.execPath, [script, JSON.stringify(crashPlan)], {
      encoding: 'utf8',
      timeout: 60_000,
      env: { ...process.env, HOME: dir, CLEO_HOME: join(dir, 'cleo-home') },
    });
    expect(child.status, child.stderr).toBe(7);

    const after = new DatabaseSync(projectDbPath, { readOnly: true });
    try {
      expect(n(after, "SELECT count(*) AS n FROM tasks_tasks WHERE id LIKE 'T%'")).toBe(
        LEGACY_TASKS,
      );
      expect(n(after, 'SELECT count(*) AS n FROM _sync_capture')).toBe(capturesBefore);
      expect(suspectTables(after)).toContain('tasks_tasks');
    } finally {
      after.close();
    }
  });
});
