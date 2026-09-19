/** Real canonical schemas and triggers, synthetic source data only (T12260). */
import { execFileSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { expect, it, vi } from 'vitest';
import { openDualScopeDbAtPath } from '../dual-scope-db.js';
import { maybeRunExodusOnOpen } from '../exodus/on-open.js';

it.each([
  false,
  true,
])('migrates canonical task guards and handoff mirror; forced abort=%s', async (abort) => {
  const root = mkdtempSync(join(tmpdir(), 'cleo-exodus-canonical-'));
  const cleoDir = join(root, '.cleo');
  const globalDir = join(root, 'global');
  mkdirSync(cleoDir);
  mkdirSync(globalDir);
  vi.stubEnv('CLEO_DIR', cleoDir);
  vi.stubEnv('CLEO_HOME', globalDir);
  vi.stubEnv('NEXUS_HOME', join(root, 'nexus'));
  vi.stubEnv('CLEO_DISABLE_EXODUS_ON_OPEN', '1');
  const target = join(cleoDir, 'cleo.db');
  const handle = await openDualScopeDbAtPath('project', target, root, { dedicated: true });
  try {
    const db = handle.db.$client as DatabaseSync;
    expect(
      db
        .prepare(
          "SELECT count(*) AS n FROM sqlite_master WHERE type='trigger' AND tbl_name='tasks_tasks'",
        )
        .get()?.n,
    ).toBeGreaterThan(0);
    db.exec(
      "INSERT INTO tasks_sessions(id,name,handoff_json) VALUES('preserved-session','Existing session','before'); CREATE TABLE unrelated(id INTEGER PRIMARY KEY,payload TEXT); INSERT INTO unrelated VALUES(1,'preserved')",
    );
    const source = new DatabaseSync(join(cleoDir, 'tasks.db'));
    try {
      source.exec(
        "CREATE TABLE tasks(id TEXT PRIMARY KEY,title TEXT,created_at TEXT); INSERT INTO tasks VALUES('T-legacy','Historical task','2026-09-19T00:00:00Z'); CREATE TABLE session_handoff_entries(id INTEGER PRIMARY KEY,session_id TEXT,handoff_json TEXT,created_at TEXT); INSERT INTO session_handoff_entries VALUES(1,'preserved-session','after','2026-09-19T00:00:00Z')",
      );
      if (abort)
        source.exec("INSERT INTO tasks VALUES('T-invalid','Rejected timestamp','invalid')");
    } finally {
      source.close();
    }
    const preCutover = join(root, 'before-cutover.db');
    db.prepare('VACUUM INTO ?').run(preCutover);
    vi.stubEnv('CLEO_DISABLE_EXODUS_ON_OPEN', '0');
    const result = await maybeRunExodusOnOpen('project', target, db, root);
    expect(result.outcome, result.reason).toBe(abort ? 'aborted' : 'migrated');
    if (abort) expect(result.recovery?.complete, result.reason).toBe(true);
    const persisted = JSON.parse(
      execFileSync(
        process.execPath,
        [
          '--input-type=module',
          '-e',
          `
      import {DatabaseSync} from 'node:sqlite';
      const db = new DatabaseSync(process.argv[1],{readOnly:true});
      process.stdout.write(JSON.stringify({tasks:db.prepare('SELECT id FROM tasks_tasks ORDER BY id').all(),handoff:db.prepare('SELECT handoff_json FROM tasks_sessions WHERE id=?').get('preserved-session'),other:db.prepare('SELECT payload FROM unrelated').all()}));
      db.close();
    `,
          target,
        ],
        { encoding: 'utf8', timeout: 10000 },
      ),
    );
    expect(persisted).toEqual({
      tasks: abort ? [] : [{ id: 'T-legacy' }],
      handoff: { handoff_json: abort ? 'before' : 'after' },
      other: [{ payload: 'preserved' }],
    });
    expect(existsSync(join(cleoDir, 'tasks.db'))).toBe(abort);
    expect(existsSync(join(cleoDir, 'exodus-complete'))).toBe(!abort);
    if (!abort) {
      handle.close();
      rmSync(target);
      rmSync(`${target}-wal`, { force: true });
      rmSync(`${target}-shm`, { force: true });
      const replacement = new DatabaseSync(target);
      try {
        replacement.exec('CREATE TABLE tasks_tasks(id TEXT PRIMARY KEY)');
        const reopened = await maybeRunExodusOnOpen('project', target, replacement, root);
        expect(reopened.outcome, reopened.reason).toBe('aborted');
        expect(reopened.reason).toMatch(/generation/);
      } finally {
        replacement.close();
      }
      copyFileSync(preCutover, target);
      const restored = new DatabaseSync(target);
      try {
        const reopened = await maybeRunExodusOnOpen('project', target, restored, root);
        expect(reopened.outcome, reopened.reason).toBe('aborted');
        expect(reopened.reason).toMatch(/generation/);
        expect(restored.prepare('SELECT payload FROM unrelated').get()?.payload).toBe('preserved');
      } finally {
        restored.close();
      }
    }
  } finally {
    handle.close();
    vi.unstubAllEnvs();
    rmSync(root, { recursive: true, force: true });
  }
});
