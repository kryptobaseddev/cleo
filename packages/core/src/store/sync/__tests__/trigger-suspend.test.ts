/**
 * The trigger-suspension flag table and the owned triggers' clause (journal
 * spec §3.5 Rule 4 and §2.3a rules 4, 9, 10; C2 T12819, C4 T12821, D4 T12827).
 *
 * Every store is a fresh project `cleo.db` opened through the chokepoint
 * (`openDualScopeDbAtPath`) under a `mkdtemp` directory, with CLEO_HOME
 * pointed at the same temp tree.
 *
 * @task T12819
 */

import { cpSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { drizzle } from 'drizzle-orm/node-sqlite';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { syncTriggersDoctorCheck } from '../../../doctor/sync-triggers.js';
import { _resetDualScopeDbCache, openDualScopeDbAtPath } from '../../dual-scope-db.js';
import { runBracketedMigrations } from '../../migration-runner.js';
import { setCaptureEnabled } from '../capture.js';
import { dropSyncMachinery } from '../machinery.js';
import { ensureSyncSchema } from '../schema.js';
import {
  assertTriggerSuspendEmpty,
  classifyStoreTriggers,
  ensureTriggerSuspendTable,
  normalizeSql,
  OWNED_TRIGGERS,
  ownedTriggerDdl,
  suspendClause,
  TRIGGER_CLAUSE_MIGRATION,
  TRIGGER_SUSPEND_TABLE_DDL,
  verifyOwnedTriggers,
  withTriggersSuspended,
} from '../trigger-classes.js';
import { ensureTriggerSuspendTableAtPath } from '../trigger-suspend-at-path.js';

const PROJECT_FOLDER = resolve(import.meta.dirname, '../../../../migrations/drizzle-cleo-project');
const SYNC_SCHEMA = resolve(import.meta.dirname, '../../../../migrations/sync-journal');

let dir: string;
let dbPath: string;

async function openStore(): Promise<DatabaseSync> {
  const handle = await openDualScopeDbAtPath('project', dbPath);
  return handle.db.$client as DatabaseSync;
}

async function reopen(): Promise<DatabaseSync> {
  _resetDualScopeDbCache();
  return openStore();
}

function liveSql(db: DatabaseSync, name: string): string | undefined {
  return (
    db.prepare("SELECT sql FROM sqlite_master WHERE type = 'trigger' AND name = ?").get(name) as
      | { sql: string }
      | undefined
  )?.sql;
}

const insertDoneTask = (db: DatabaseSync, id: string) =>
  db
    .prepare(
      "INSERT INTO tasks_tasks (id, title, type, status, pipeline_stage) VALUES (?, 'x', 'task', 'done', NULL)",
    )
    .run(id);

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'cleo-trigger-suspend-'));
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

describe('the C2 migration', () => {
  it('creates the flag table and gives every owned trigger its clause', async () => {
    const db = await openStore();
    expect(
      db.prepare("SELECT sql FROM sqlite_master WHERE name = 'cleo_trigger_suspend'").get(),
    ).toBeDefined();
    for (const [name, cls] of Object.entries(OWNED_TRIGGERS)) {
      const sql = liveSql(db, name);
      expect(sql, name).toBeDefined();
      expect(normalizeSql(sql as string), name).toContain(normalizeSql(suspendClause(cls)));
    }
    expect(verifyOwnedTriggers(db)).toEqual([]);
  });

  it('the step-0 DDL is byte-identical to the migration statement', () => {
    const [first] = ownedMigrationStatements();
    expect(first?.trim().replace(/;$/, '')).toBe(TRIGGER_SUSPEND_TABLE_DDL);
  });

  it('is never probe-stamped: a store at the previous head runs it even with the table pre-created', () => {
    const native = new DatabaseSync(join(dir, 'prev.db'));
    native.exec('PRAGMA foreign_keys = ON');
    const prev = previousHeadFolder();
    const lineage = (folder: string) => [
      { folder, reconcile: { existenceTable: 'tasks_tasks', logSubsystem: 'c2-test' } },
    ];
    runBracketedMigrations(native, drizzle({ client: native }), lineage(prev));
    ensureTriggerSuspendTable(native); // step 0, before the next migration run
    expect(normalizeSql(liveSql(native, 'tasks_tasks_lease_iso_insert') ?? '')).not.toContain(
      'cleo_trigger_suspend',
    );
    const report = runBracketedMigrations(
      native,
      drizzle({ client: native }),
      lineage(PROJECT_FOLDER),
    );
    expect(report.applied).toContain(TRIGGER_CLAUSE_MIGRATION);
    // The graveyard trigger's owned text is installed by the open pass (its
    // table may be missing), so a migration-only store still has t12341's.
    expect(verifyOwnedTriggers(native)).toEqual([
      { name: 'trg_tasks_ac_uid_graveyard', problem: 'no-clause', repaired: false },
    ]);
    native.close();
  });
});

describe('suspension by flag row', () => {
  it('a guard is off only inside the suspending transaction, and the rows never commit', async () => {
    const db = await openStore();
    expect(() => insertDoneTask(db, 'T1')).toThrow(/T877_INVARIANT_VIOLATION/);
    db.exec('BEGIN IMMEDIATE');
    withTriggersSuspended(db, ['guard'], 'rewind', () => insertDoneTask(db, 'T2'));
    db.exec('COMMIT');
    expect(
      (db.prepare('SELECT count(*) AS n FROM cleo_trigger_suspend').get() as { n: number }).n,
    ).toBe(0);
    expect(() => insertDoneTask(db, 'T3')).toThrow(/T877_INVARIANT_VIOLATION/);
  });

  it('guards are suspended only to rewind or undo, never for a forward write (T12344 AC5)', async () => {
    const db = await openStore();
    db.exec('BEGIN IMMEDIATE');
    for (const scopes of [['guard'], ['all']] as const) {
      expect(() =>
        withTriggersSuspended(db, scopes, 'forward', () => insertDoneTask(db, 'T9')),
      ).toThrow(/E_GUARD_SUSPEND_FORWARD/);
    }
    db.exec('ROLLBACK');
    expect(db.prepare("SELECT 1 FROM tasks_tasks WHERE id = 'T9'").get()).toBeUndefined();
  });

  it('a side-effect trigger is off while suspended (claim release on session end)', async () => {
    const db = await openStore();
    db.exec(`INSERT INTO tasks_sessions (id, name, status) VALUES ('S1', 's', 'active');
             INSERT INTO tasks_tasks (id, title, type, status, claimed_by_session) VALUES ('T1', 'x', 'task', 'active', 'S1');`);
    db.exec('BEGIN IMMEDIATE');
    withTriggersSuspended(db, ['side-effect'], 'forward', () =>
      db.exec("UPDATE tasks_sessions SET status = 'ended' WHERE id = 'S1'"),
    );
    db.exec('COMMIT');
    expect(
      (
        db.prepare("SELECT claimed_by_session AS s FROM tasks_tasks WHERE id = 'T1'").get() as {
          s: string | null;
        }
      ).s,
    ).toBe('S1');
  });

  it('refuses to commit a suspension row (C4)', async () => {
    const db = await openStore();
    db.exec('BEGIN IMMEDIATE');
    db.exec("INSERT INTO cleo_trigger_suspend VALUES ('guard')");
    expect(() => assertTriggerSuspendEmpty(db)).toThrow(/E_TRIGGER_SUSPEND_NOT_EMPTY/);
    db.exec('ROLLBACK');
  });

  it('the open pass clears a committed suspension row', async () => {
    const db = await openStore();
    db.exec("INSERT INTO cleo_trigger_suspend VALUES ('guard')");
    const again = await reopen();
    expect(
      (again.prepare('SELECT count(*) AS n FROM cleo_trigger_suspend').get() as { n: number }).n,
    ).toBe(0);
    expect(() => insertDoneTask(again, 'T1')).toThrow(/T877_INVARIANT_VIOLATION/);
  });
});

describe('the open pass', () => {
  it('step 0 recreates a missing flag table before any write (C2, round 9)', async () => {
    const db = await openStore();
    db.exec('DROP TABLE cleo_trigger_suspend');
    expect(() => insertDoneTask(db, 'T1')).toThrow(/no such table/);
    const again = await reopen();
    expect(() =>
      again
        .prepare(
          "INSERT INTO tasks_tasks (id, title, type, status) VALUES ('T2', 'x', 'task', 'active')",
        )
        .run(),
    ).not.toThrow();
  });

  it('repairs an owned trigger an older build recreated without its clause', async () => {
    const db = await openStore();
    db.exec(`DROP TRIGGER tasks_tasks_lease_iso_insert;
             CREATE TRIGGER tasks_tasks_lease_iso_insert BEFORE INSERT ON tasks_tasks
             WHEN NEW.claimed_at IS NOT NULL AND NEW.claimed_at NOT GLOB '[0-9]*'
             BEGIN SELECT RAISE(ABORT, 'old'); END;`);
    expect(verifyOwnedTriggers(db)).toEqual([
      { name: 'tasks_tasks_lease_iso_insert', problem: 'no-clause', repaired: false },
    ]);
    const again = await reopen();
    expect(verifyOwnedTriggers(again)).toEqual([]);
  });

  it('a store without the AC graveyard table (T12341 probe-stamped) keeps AC deletes working', async () => {
    const db = await openStore();
    db.exec('DROP TRIGGER trg_tasks_ac_uid_graveyard; DROP TABLE tasks_ac_uid_graveyard;');
    // The trigger as a migration that created it unconditionally would leave it.
    db.exec(ownedTriggerDdl().get('trg_tasks_ac_uid_graveyard') as string);
    db.exec(`INSERT INTO tasks_tasks (id, title, type, status) VALUES ('T1', 'x', 'task', 'pending');
             INSERT INTO tasks_task_acceptance_criteria (id, task_id, ordinal, kind, text, uid)
               VALUES ('A1', 'T1', 1, 'text', 'ac', 'u1'), ('A2', 'T1', 2, 'text', 'ac2', 'u2');`);
    expect(() => db.exec("DELETE FROM tasks_task_acceptance_criteria WHERE id = 'A1'")).toThrow(
      /no such table: main.tasks_ac_uid_graveyard/,
    );
    expect(verifyOwnedTriggers(db)).toEqual([
      { name: 'trg_tasks_ac_uid_graveyard', problem: 'dangling', repaired: false },
    ]);
    const again = await reopen();
    expect(liveSql(again, 'trg_tasks_ac_uid_graveyard')).toBeUndefined();
    expect(verifyOwnedTriggers(again)).toEqual([]);
    again.exec("DELETE FROM tasks_task_acceptance_criteria WHERE id = 'A2'");
  });

  it('a drizzle-style rebuild of tasks_tasks, then an open, leaves every owned trigger with its clause (C2(d))', async () => {
    const db = await openStore();
    const create = (
      db
        .prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'tasks_tasks'")
        .get() as {
        sql: string;
      }
    ).sql.replace(/CREATE TABLE [`"]?tasks_tasks[`"]?/, 'CREATE TABLE `__new_tasks_tasks`');
    // A rebuild must first drop every trigger whose text references the
    // table (ALTER … RENAME re-validates them all, §2.3a rule 5); dropping
    // the table drops its own triggers.
    const referencing = (
      db
        .prepare(
          "SELECT name FROM sqlite_master WHERE type = 'trigger' AND sql LIKE '%tasks_tasks%'",
        )
        .all() as Array<{ name: string }>
    ).map((r) => r.name);
    db.exec('PRAGMA foreign_keys = OFF');
    db.exec(`BEGIN;
             ${referencing.map((t) => `DROP TRIGGER "${t}";`).join('\n')}
             ${create};
             INSERT INTO __new_tasks_tasks SELECT * FROM tasks_tasks;
             DROP TABLE tasks_tasks;
             ALTER TABLE __new_tasks_tasks RENAME TO tasks_tasks; COMMIT;`);
    db.exec('PRAGMA foreign_keys = ON');
    expect(liveSql(db, 'trg_tasks_tasks_status_pipeline_insert')).toBeUndefined();
    expect(liveSql(db, 'tasks_task_relations_non_containment_insert')).toBeUndefined();
    const again = await reopen();
    expect(verifyOwnedTriggers(again)).toEqual([]);
    expect(classifyStoreTriggers(again, 'project').unclassified).toEqual([]);
  });
});

describe('ownership', () => {
  it('dropSyncMachinery drops _sync_* tables and leaves cleo_trigger_suspend and tasks writable', async () => {
    const db = await openStore();
    ensureSyncSchema(db, { root: SYNC_SCHEMA });
    const dropped = dropSyncMachinery(db);
    expect(dropped.tables).toContain('_sync_meta');
    expect(
      db.prepare("SELECT 1 FROM sqlite_master WHERE name = 'cleo_trigger_suspend'").get(),
    ).toBeDefined();
    expect(() =>
      db
        .prepare(
          "INSERT INTO tasks_tasks (id, title, type, status) VALUES ('T1', 'x', 'task', 'active')",
        )
        .run(),
    ).not.toThrow();
  });

  it('the T12341 §13 rollback, after capture off and dropSyncMachinery (rule 10), leaves cleo_trigger_suspend and writes working', async () => {
    const db = await openStore();
    setCaptureEnabled(db, 'project', true, { schemaRoot: SYNC_SCHEMA });
    // Rule 10, step 0: capture off; then remove the journal.
    setCaptureEnabled(db, 'project', false);
    dropSyncMachinery(db);
    // T12341 §13 step 3, in one transaction.
    const t12341 = '20260928120000_t12341-row-uids';
    const hash = (
      db.prepare('SELECT hash FROM __drizzle_migrations WHERE name = ?').get(t12341) as {
        hash: string;
      }
    ).hash;
    const uniq = (
      db
        .prepare(
          "SELECT name FROM sqlite_master WHERE type = 'index' AND (name LIKE 'uq_%_uid' OR name LIKE 'idx_%ac_uid' OR name LIKE 'idx_%ac_text_hash')",
        )
        .all() as Array<{ name: string }>
    ).map((r) => r.name);
    const dropCols: Array<[string, string]> = [
      ['tasks_tasks', 'uid'],
      ['tasks_tasks', 'birth_fp'],
      ['tasks_task_acceptance_criteria', 'uid'],
      ['tasks_task_acceptance_criteria', 'birth_fp'],
      ['tasks_task_acceptance_criteria_history', 'uid'],
      ['tasks_task_acceptance_criteria_history', 'ac_uid'],
      ['tasks_task_acceptance_criteria_history', 'birth_fp'],
      ['tasks_evidence_ac_bindings', 'uid'],
      ['tasks_evidence_ac_bindings', 'ac_uid'],
      ['tasks_evidence_ac_bindings', 'birth_fp'],
      ['tasks_evidence_ac_bindings', 'ac_text_hash'],
      ['tasks_sessions', 'uid'],
      ['tasks_sessions', 'birth_fp'],
      ['tasks_task_dependencies', 'uid'],
      ['tasks_task_relations', 'uid'],
      ['tasks_task_labels', 'uid'],
    ];
    db.exec('BEGIN IMMEDIATE');
    for (const i of uniq) db.exec(`DROP INDEX "${i}"`);
    db.exec('DROP TRIGGER IF EXISTS trg_tasks_ac_uid_graveyard');
    for (const t of ['tasks_ac_uid_graveyard', 'tasks_display_id_aliases', 'tasks_uid_aliases']) {
      db.exec(`DROP TABLE IF EXISTS "${t}"`);
    }
    for (const [t, c] of dropCols) db.exec(`ALTER TABLE "${t}" DROP COLUMN "${c}"`);
    db.prepare('DELETE FROM __drizzle_migrations WHERE hash = ?').run(hash);
    db.exec('COMMIT');

    expect(
      db.prepare("SELECT 1 FROM sqlite_master WHERE name = 'cleo_trigger_suspend'").get(),
    ).toBeDefined();
    db.exec(`INSERT INTO tasks_sessions (id, name, status) VALUES ('S1', 's', 'active');
             INSERT INTO tasks_tasks (id, title, type, status) VALUES ('T1', 'x', 'task', 'pending');
             INSERT INTO tasks_task_acceptance_criteria (id, task_id, ordinal, kind, text) VALUES ('A1', 'T1', 1, 'text', 'ac');
             DELETE FROM tasks_task_acceptance_criteria WHERE id = 'A1';
             UPDATE tasks_sessions SET status = 'ended' WHERE id = 'S1';`);
    expect(() => insertDoneTask(db, 'T2')).toThrow(/T877_INVARIANT_VIOLATION/);
    // This build's next open re-applies T12341 and the graveyard trigger.
    const again = await reopen();
    expect(verifyOwnedTriggers(again)).toEqual([]);
  });

  it('every trigger of a chokepoint-opened project store is classified', async () => {
    const db = await openStore();
    const { classified, unclassified } = classifyStoreTriggers(db, 'project');
    expect(unclassified).toEqual([]);
    const owned = classified.filter((t) => t.class === 'guard' || t.class === 'side-effect');
    expect(owned.length).toBe(Object.keys(OWNED_TRIGGERS).length);
  });

  it('owned DDL is read from the C2 migration on, plus the code-held graveyard trigger', () => {
    expect([...ownedTriggerDdl(PROJECT_FOLDER).keys()].sort()).toEqual(
      Object.keys(OWNED_TRIGGERS).sort(),
    );
  });
});

describe('doctor sync_triggers and placed stores', () => {
  const projectRoot = () => join(dir, 'project');

  it('reports ok on a migrated store, error without the table, warning for a trigger without its clause', async () => {
    const db = await openStore();
    expect(syncTriggersDoctorCheck(projectRoot())).toMatchObject({
      check: 'sync_triggers',
      status: 'ok',
    });
    db.exec(`DROP TRIGGER tasks_tasks_release_claim_on_terminal;
             CREATE TRIGGER tasks_tasks_release_claim_on_terminal AFTER UPDATE OF status ON tasks_tasks
             BEGIN SELECT 1; END;`);
    expect(syncTriggersDoctorCheck(projectRoot())).toMatchObject({ status: 'warning' });
    db.exec('DROP TABLE cleo_trigger_suspend');
    const r = syncTriggersDoctorCheck(projectRoot());
    expect(r.status).toBe('error');
    expect(r.message).toMatch(/cleo_trigger_suspend is missing/);
    expect(r.fix).toMatch(/open pass/);
  });

  it('a placed project store gets the table; a non-project file is left alone', async () => {
    const db = await openStore();
    db.exec('DROP TABLE cleo_trigger_suspend');
    _resetDualScopeDbCache();
    expect(ensureTriggerSuspendTableAtPath(dbPath)).toEqual({ created: true, cleared: 0 });
    const other = join(dir, 'other.db');
    new DatabaseSync(other).close();
    expect(ensureTriggerSuspendTableAtPath(other)).toBeNull();
  });
});

// ── helpers that read the lineage ─────────────────────────────────────────

function ownedMigrationStatements(): string[] {
  return readFileSync(join(PROJECT_FOLDER, TRIGGER_CLAUSE_MIGRATION, 'migration.sql'), 'utf8')
    .split('--> statement-breakpoint')
    .map((s) => s.replace(/^(?:\s*--[^\n]*\n|\s*\n)*/, ''));
}

/** A copy of the lineage without the C2 migration and anything after it. */
function previousHeadFolder(): string {
  const out = join(dir, 'prev-lineage');
  mkdirSync(out);
  for (const d of readdirSync(PROJECT_FOLDER)) {
    if (d >= TRIGGER_CLAUSE_MIGRATION) continue;
    cpSync(join(PROJECT_FOLDER, d), join(out, d), { recursive: true });
  }
  return out;
}
