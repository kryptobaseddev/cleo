/**
 * The REPLACE → UPSERT audit that gates `recursive_triggers = ON` (journal
 * spec §2.3 M1, N9 T12765; T12787).
 *
 * With recursion on, a REPLACE fires DELETE triggers even for a same-PK
 * conflict, and a REPLACE into an FK-action parent cascades (FK actions are
 * not triggers, so that one fires even with recursion off). T12787 banned
 * REPLACE everywhere (gate 28, zero tolerance; `// replace-allowed` only for
 * the vec0 `brain_embeddings`, which has no triggers and is no FK parent).
 * This test pins the other half: the AFTER DELETE triggers the audit covers,
 * and that the UPSERT writers leave live claims, the AC graveyard and the FTS
 * index untouched on a capture connection (recursion on).
 *
 * Every store is a temp project `cleo.db` opened through the chokepoint.
 *
 * @task T12765
 */

import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { bindConduitDomain } from '../../conduit-sqlite.js';
import { _resetDualScopeDbCache, openDualScopeDb } from '../../dual-scope-db.js';
import { setCaptureEnabled } from '../capture.js';

const SYNC_SCHEMA = resolve(import.meta.dirname, '../../../../migrations/sync-journal');

let dir: string;
let projectDir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'cleo-recursion-audit-'));
  projectDir = join(dir, 'project');
  mkdirSync(join(projectDir, '.cleo'), { recursive: true });
  mkdirSync(join(dir, 'cleo'), { recursive: true });
  vi.stubEnv('CLEO_HOME', join(dir, 'cleo'));
  vi.stubEnv('CLEO_ROOT', undefined);
  vi.stubEnv('CLEO_DIR', undefined);
  // Written against row uids off; on by default since T13305 (C2). The
  // capture + fill-on interplay (K captures alongside I/U/D) is T13311.
  vi.stubEnv('CLEO_ROW_UID_FILL', '0');
});

afterEach(() => {
  _resetDualScopeDbCache();
  vi.unstubAllEnvs();
  rmSync(dir, { recursive: true, force: true });
});

async function store(): Promise<DatabaseSync> {
  const handle = await openDualScopeDb('project', projectDir);
  await bindConduitDomain(projectDir);
  const db = handle.db.$client as DatabaseSync;
  setCaptureEnabled(db, 'project', true, { schemaRoot: SYNC_SCHEMA });
  return db;
}

const n = (db: DatabaseSync, sql: string) => (db.prepare(sql).get() as { n: number }).n;

describe('recursive_triggers audit', () => {
  it('the AFTER DELETE triggers of a project store are exactly the audited set', async () => {
    const db = await store();
    const afterDelete = (
      db.prepare("SELECT name, sql FROM sqlite_master WHERE type = 'trigger'").all() as Array<{
        name: string;
        sql: string;
      }>
    )
      .filter((t) => /\bAFTER\s+DELETE\s+ON\b/i.test(t.sql))
      .map((t) => t.name)
      .filter((name) => !name.startsWith('_sync_cap_'))
      .sort();
    // Claim release (#1701), the AC graveyard (T12341), FTS delete legs and
    // the twin-collapse change trackers. Capture `_d` triggers are the rest.
    expect(afterDelete).toEqual(
      [
        'conduit_messages_ad',
        'nexus_nodes_fts_ad',
        't12535_track_attachment_refs_delete',
        't12535_track_attachments_delete',
        'tasks_sessions_release_claims_on_delete',
        'trg_tasks_ac_uid_graveyard',
      ].filter((t) =>
        db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'trigger' AND name = ?").get(t),
      ),
    );
    expect(afterDelete).toContain('tasks_sessions_release_claims_on_delete');
    expect(afterDelete).toContain('trg_tasks_ac_uid_graveyard');
    expect(afterDelete).toContain('conduit_messages_ad');
    expect(
      (db.prepare('PRAGMA recursive_triggers').get() as { recursive_triggers: number })
        .recursive_triggers,
    ).toBe(1);
  });

  it('with recursion on, UPSERT writers keep live claims, the graveyard and the FTS index', async () => {
    const db = await store();
    db.exec(`
      INSERT INTO tasks_sessions (id, name, status) VALUES ('S1', 's', 'active');
      INSERT INTO tasks_tasks (id, title, type, status, claimed_by_session, claimed_at)
        VALUES ('T1', 't', 'task', 'active', 'S1', '2026-09-30T00:00:00Z');
      INSERT INTO tasks_task_acceptance_criteria (id, task_id, ordinal, kind, text, uid)
        VALUES ('AC1', 'T1', 1, 'text', 'first', 'uid-ac1');
      INSERT INTO conduit_conversations (id, participants) VALUES ('c', '["a","b"]');
      INSERT INTO conduit_messages (id, conversation_id, from_agent_id, to_agent_id, content)
        VALUES ('M1', 'c', 'a', 'b', 'hello world');
    `);
    const graveyard = n(db, 'SELECT count(*) AS n FROM tasks_ac_uid_graveyard');
    const fts = n(db, 'SELECT count(*) AS n FROM conduit_messages_fts');

    // Same-PK upserts: the UPDATE leg runs, never a DELETE.
    db.exec(`
      INSERT INTO tasks_sessions (id, name, status) VALUES ('S1', 's2', 'active')
        ON CONFLICT(id) DO UPDATE SET name = excluded.name;
      INSERT INTO tasks_task_acceptance_criteria (id, task_id, ordinal, kind, text, uid)
        VALUES ('AC1', 'T1', 1, 'text', 'first, edited', 'uid-ac1')
        ON CONFLICT(id) DO UPDATE SET text = excluded.text;
      INSERT INTO conduit_messages (id, conversation_id, from_agent_id, to_agent_id, content)
        VALUES ('M1', 'c', 'a', 'b', 'hello again')
        ON CONFLICT(id) DO UPDATE SET content = excluded.content;
    `);

    expect(
      db.prepare("SELECT claimed_by_session AS s FROM tasks_tasks WHERE id = 'T1'").get(),
    ).toEqual({ s: 'S1' });
    expect(n(db, 'SELECT count(*) AS n FROM tasks_ac_uid_graveyard')).toBe(graveyard);
    expect(n(db, 'SELECT count(*) AS n FROM conduit_messages_fts')).toBe(fts);
    expect(
      n(
        db,
        "SELECT count(*) AS n FROM conduit_messages_fts WHERE conduit_messages_fts MATCH 'again'",
      ),
    ).toBe(1);
    // Each upsert captured as one U, never a D + I.
    const ops = (
      db
        .prepare(
          "SELECT op FROM _sync_capture WHERE tbl IN ('tasks_sessions', 'tasks_task_acceptance_criteria') ORDER BY seq",
        )
        .all() as Array<{ op: string }>
    ).map((r) => r.op);
    expect(ops).toEqual(['I', 'I', 'U', 'U']);
  });
});
