/**
 * T12535 — the playbook twin collapse: the bare `playbook_runs` /
 * `playbook_approvals` rows an older build wrote are carried into
 * `tasks_playbook_runs` / `tasks_playbook_approvals` (which this build reads,
 * writes and syncs), then the bare tables are frozen so an older build cannot
 * start a run or decide an approval the twins would never see. The project
 * sticky and playbook tables are in the journal's sync set (the state layer
 * itself is tested against the twins in `packages/playbooks`).
 *
 * Every open goes through the real tasks-domain bind (`bindTasksDomain`).
 *
 * @task T12535
 * @epic T12323
 */

import { mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { bindTasksDomain, closeDb } from '../sqlite.js';
import { legacyStrands, syncSetTables } from '../sync/flags.js';
import {
  inspectTwinCollapse,
  PLAYBOOKS_ARCHIVE_KEY,
  playbooksFrozenMessage,
  TWIN_COLLAPSE_MARKER_PREFIX,
} from '../twin-collapse.js';
import { optOutOfForeignKeys } from './test-db-helper.js';

// Fixtures seed bare approvals before their runs exist in the twin.
optOutOfForeignKeys();

const MARKER = `${TWIN_COLLAPSE_MARKER_PREFIX}playbook_runs`;
const AT = '2026-09-01 10:00:00';

let root: string;
const saved: Record<string, string | undefined> = {};

beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), 'cleo-playbook-twin-T12535-')));
  mkdirSync(join(root, '.cleo'), { recursive: true });
  for (const k of ['CLEO_DIR', 'CLEO_HOME']) saved[k] = process.env[k];
  process.env['CLEO_DIR'] = join(root, '.cleo');
  process.env['CLEO_HOME'] = join(root, 'cleo-home');
});

afterEach(() => {
  closeDb();
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
});

async function open(): Promise<DatabaseSync> {
  return (await bindTasksDomain(root)).native;
}

async function reopen(): Promise<DatabaseSync> {
  closeDb();
  return open();
}

/** Undo this build's collapse so the store looks like one an older build wrote. */
function asOlderBuildStore(db: DatabaseSync): void {
  for (const r of db
    .prepare(
      "SELECT name FROM main.sqlite_master WHERE type = 'trigger' AND name LIKE 't12535_freeze_playbook%'",
    )
    .all() as Array<{ name: string }>)
    db.exec(`DROP TRIGGER main.${r.name}`);
  db.prepare('DELETE FROM main.tasks_schema_meta WHERE key = ?').run(MARKER);
}

function bareRun(db: DatabaseSync, table: string, runId: string, status: string): void {
  db.prepare(
    `INSERT INTO main.${table} (run_id, playbook_name, playbook_hash, status, started_at) VALUES (?, 'rcasd', 'h1', ?, ?)`,
  ).run(runId, status, AT);
}

function bareApproval(db: DatabaseSync, id: string, runId: string, token: string): void {
  db.prepare(
    "INSERT INTO main.playbook_approvals (approval_id, run_id, node_id, token, requested_at, status) VALUES (?, ?, 'gate', ?, ?, 'approved')",
  ).run(id, runId, token, AT);
}

const statusOf = (db: DatabaseSync, table: string, runId: string): unknown =>
  (
    db.prepare(`SELECT status FROM main.${table} WHERE run_id = ?`).get(runId) as
      | { status: string }
      | undefined
  )?.status;

describe('playbook twin collapse (T12535)', () => {
  it('carries bare rows into the twins, the bare row winning an initial difference (archived)', async () => {
    let db = await open();
    asOlderBuildStore(db);
    bareRun(db, 'playbook_runs', 'run-carry', 'paused');
    bareApproval(db, 'appr-carry', 'run-carry', 'tok-carry');
    // An exodus copy of a run the older build moved on since.
    bareRun(db, 'playbook_runs', 'run-moved', 'completed');
    bareRun(db, 'tasks_playbook_runs', 'run-moved', 'running');
    // A twin-only row is kept (union).
    bareRun(db, 'tasks_playbook_runs', 'run-twin-only', 'running');

    db = await reopen();
    expect(statusOf(db, 'tasks_playbook_runs', 'run-carry')).toBe('paused');
    expect(statusOf(db, 'tasks_playbook_runs', 'run-moved')).toBe('completed');
    expect(statusOf(db, 'tasks_playbook_runs', 'run-twin-only')).toBe('running');
    expect(
      db
        .prepare("SELECT token FROM tasks_playbook_approvals WHERE approval_id = 'appr-carry'")
        .get(),
    ).toEqual({ token: 'tok-carry' });
    const archive = db
      .prepare('SELECT value FROM tasks_schema_meta WHERE key = ?')
      .get(PLAYBOOKS_ARCHIVE_KEY) as { value: string };
    expect(Object.keys(JSON.parse(archive.value))).toEqual(['playbook_runs\trun-moved']);
    expect(JSON.parse(archive.value)['playbook_runs\trun-moved']).toContain('running');
    // Nothing is stranded from the journal, and the bare rows are untouched.
    expect(legacyStrands(db)).toEqual([]);
    expect(db.prepare('SELECT count(*) AS n FROM playbook_runs').get()).toEqual({ n: 2 });
    const playbooks = inspectTwinCollapse(db).find((s) => s.table === 'playbook_runs');
    expect(playbooks?.state).toBe('collapsed');
  });

  it('freezes the bare tables: an older-build write aborts with the upgrade message', async () => {
    const db = await open();
    expect(() => bareRun(db, 'playbook_runs', 'run-old', 'running')).toThrow(
      'CLEO: playbook runs moved to tasks_playbook_runs (T12535)',
    );
    expect(() => bareApproval(db, 'a-old', 'r', 't')).toThrow(/needs .* to run playbooks/);
    expect(playbooksFrozenMessage(null)).toMatch(/npm i -g @cleocode\/cleo@latest/);
    // A freeze dropped by a rebuild or restore is put back at the next open.
    asOlderBuildStore(db);
    const again = await reopen();
    expect(() => bareRun(again, 'playbook_runs', 'run-old', 'running')).toThrow(/T12535/);
  });

  it('the playbook twins and the project sticky tables are in the sync set; the bare twins are not', async () => {
    await open();
    const sync = syncSetTables('project');
    for (const t of [
      'tasks_playbook_runs',
      'tasks_playbook_approvals',
      'brain_sticky_notes',
      'brain_sticky_tags',
    ])
      expect(sync).toContain(t);
    for (const t of ['playbook_runs', 'playbook_approvals']) expect(sync).not.toContain(t);
  });
});
